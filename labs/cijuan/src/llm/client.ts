import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { AiProfile } from '../types'
import { compatEndpoint, presetFor } from './providers'

/**
 * 纯前端架构：浏览器直连各家 API，key 由用户在设置页填入、只存本机。
 * 两条通道：
 * - anthropic → 官方 SDK（结构化输出 + 流式防超时）。dangerouslyAllowBrowser
 *   的风险是 key 暴露给页面脚本；本应用单人自用、无第三方脚本，属正当场景。
 * - 其余（deepseek / openai / ollama / lmstudio / custom）→ OpenAI 兼容
 *   chat/completions，JSON Schema 写进提示词，返回后本地 zod 校验。
 */
export async function callStructured<S extends z.ZodType>(opts: {
  profile: AiProfile
  prompt: string
  schema: S
  maxTokens?: number
}): Promise<z.infer<S>> {
  return opts.profile.provider === 'anthropic'
    ? callAnthropic(opts)
    : callOpenAiCompat(opts)
}

async function callAnthropic<S extends z.ZodType>(opts: {
  profile: AiProfile
  prompt: string
  schema: S
  maxTokens?: number
}): Promise<z.infer<S>> {
  const { profile, schema } = opts
  const client = new Anthropic({
    apiKey: profile.apiKey,
    baseURL: profile.baseUrl.trim() || undefined,
    dangerouslyAllowBrowser: true,
  })
  const stream = client.messages.stream({
    model: profile.model,
    max_tokens: opts.maxTokens ?? 32000,
    messages: [{ role: 'user', content: opts.prompt }],
    output_config: { format: zodOutputFormat(schema) },
  })
  const message = await stream.finalMessage()
  // finalMessage 已按 output_config 校验并填好 parsed_output；文本兜底只防万一
  const parsed = (message as { parsed_output?: unknown }).parsed_output
  if (parsed != null) return schema.parse(parsed)
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return schema.parse(JSON.parse(text))
}

async function callOpenAiCompat<S extends z.ZodType>(opts: {
  profile: AiProfile
  prompt: string
  schema: S
  maxTokens?: number
}): Promise<z.infer<S>> {
  const { profile, schema } = opts
  const preset = presetFor(profile.provider)
  const base = profile.baseUrl.trim() || preset.baseUrl
  if (!base) throw new Error('未配置服务端点（base URL），请到设置里填写')
  const target = compatEndpoint(base, 'chat/completions')
  // 开发服务器下走同源 /llm-proxy 由 vite 本机转发（见 vite.config.ts）：
  // 第三方中转站普遍不放行浏览器 CORS，直连会死在预检上。
  // 静态部署（build 产物）没有这层，回退浏览器直连。
  const viaProxy = import.meta.env.DEV
  const url = viaProxy ? '/llm-proxy' : target

  const jsonSchema = z.toJSONSchema(schema)
  const prompt = `${opts.prompt}

## 输出格式（硬性要求）
只输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码围栏。JSON 必须符合以下 JSON Schema：
${JSON.stringify(jsonSchema)}`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`
  if (viaProxy) headers['x-proxy-target'] = target

  // response_format 只发给确定支持的服务商；custom/本地端点未必认识该字段
  const supportsJsonMode = profile.provider === 'openai' || profile.provider === 'deepseek'
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile.model,
        max_tokens: opts.maxTokens ?? 16000,
        messages: [{ role: 'user', content: prompt }],
        // 流式（SSE）：生成一整篇要一两分钟，非流式连接会被服务商网关
        // 按空闲超时掐断，浏览器只报一句 Failed to fetch
        stream: true,
        ...(supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    })
  } catch (err) {
    // fetch 层的 TypeError（网络不通 / 预检被拒 / 本地服务没开 CORS）原话没法看，翻译一下
    throw new Error(
      `连不上 ${preset.name}（${target}）：请求没到达服务器就失败了。` +
        `可能是网络不通、浏览器插件拦截，或本地服务未启动/未开启 CORS` +
        `（LM Studio 需在设置里打开 Enable CORS）。原始错误：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${preset.name} 返回 ${res.status}：${body.slice(0, 300)}`)
  }
  const content = res.headers.get('content-type')?.includes('text/event-stream')
    ? await readSseContent(res)
    : await readJsonContent(res)
  if (!content) throw new Error(`${preset.name} 返回了空响应`)
  return schema.parse(JSON.parse(extractJson(content)))
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 多轮纯文本对话（评卷页的「选取追问」用）。与 callStructured 同两条通道、
 * 同一套流式与 dev 代理策略，只是不带 JSON schema，返回原样文本。
 */
export async function callChat(opts: {
  profile: AiProfile
  system: string
  messages: ChatMessage[]
  maxTokens?: number
}): Promise<string> {
  const { profile, system, messages } = opts
  const maxTokens = opts.maxTokens ?? 2000

  if (profile.provider === 'anthropic') {
    const client = new Anthropic({
      apiKey: profile.apiKey,
      baseURL: profile.baseUrl.trim() || undefined,
      dangerouslyAllowBrowser: true,
    })
    const stream = client.messages.stream({
      model: profile.model,
      max_tokens: maxTokens,
      system,
      messages,
    })
    const message = await stream.finalMessage()
    return message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }

  const preset = presetFor(profile.provider)
  const base = profile.baseUrl.trim() || preset.baseUrl
  if (!base) throw new Error('未配置服务端点（base URL），请到设置里填写')
  const target = compatEndpoint(base, 'chat/completions')
  const viaProxy = import.meta.env.DEV
  const url = viaProxy ? '/llm-proxy' : target

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`
  if (viaProxy) headers['x-proxy-target'] = target

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile.model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: true,
      }),
    })
  } catch (err) {
    throw new Error(
      `连不上 ${preset.name}（${target}）：请求没到达服务器就失败了。` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${preset.name} 返回 ${res.status}：${body.slice(0, 300)}`)
  }
  const content = res.headers.get('content-type')?.includes('text/event-stream')
    ? await readSseContent(res)
    : await readJsonContent(res)
  if (!content) throw new Error(`${preset.name} 返回了空响应`)
  return content
}

/** 逐块读 SSE 流，拼出全部增量文本（choices[0].delta.content） */
async function readSseContent(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 事件以空行分隔；最后一段可能不完整，留在 buffer 里等下一块
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
          content += chunk.choices?.[0]?.delta?.content ?? ''
        } catch {
          // 半截 JSON 或注释行：跳过
        }
      }
    }
  }
  return content
}

/** 个别兼容端点不理会 stream 参数、直接回整包 JSON 时的兜底 */
async function readJsonContent(res: Response): Promise<string> {
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}

/** 容错：模型没听话带了围栏或前后缀时，抠出第一个完整 JSON 对象 */
function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}
