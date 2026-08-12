import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { createUuid } from '../utils/randomUuid.ts'

/**
 * LLM 传输层，替代 labs/cijuan 的 llm/client.ts。
 *
 * 词卷独立版是纯前端架构（浏览器直连各家 API，key 本机保存）；Lantern 前端零直连，
 * 全部走 Tauri command。这里换成一条通用的 `ai_complete_text`：入参 messages（多轮）
 * + system + maxTokens + cache 标记，内部走 Rust 侧的 `complete_with_failover`
 * （复用现有 ai_profiles 路由/故障切换/用量统计），一次性返回全文。
 *
 * 契约（与后端 `ai_complete_text` command 并行开发，字段名/形状须严格一致）：
 * - messages: { role: 'user' | 'assistant', content: string }[]
 * - maxTokens 必填：后端 command 的对应字段是 u32 必填参数，这里留成可选会在
 *   省略时把 `undefined` 序列化过去，触发反序列化失败——干脆在类型层堵死。
 * - cache: true 用于「续写同一对话」的调用（阶段一出题、明答校验续写、阶段二
 *   解析生成），后端把它落成「最后一条消息 + 前缀里最后一条 assistant 消息都打
 *   cache_control」，前端不用关心 Anthropic/OpenAI 兼容通道各自怎么落地这个标记。
 *   遮词自检的文本是遮改后的、前缀与阶段一不同，蹭不到缓存，不带 cache。
 * - requestId：接入现有 `ai_cancel` 取消通道（src-tauri/src/commands/ai/stream.rs）
 *   ——后端 `ai_complete_text` 的这个参数是必填的，invoke 负载必须始终带上；
 *   调用方不传时这里用 createUuid() 兜底生成一个，取消按钮的 UI 接线不在这一层，
 *   这里只把管道铺好（见下方 cancelRequest）。generate.ts 暂不需要显式传
 *   requestId——编排层还没有取消入口，默认内部生成即可，不为还不存在的取消
 *   功能提前设计编排层 API。
 * - 返回值：后端按 `{ text: string }` 返回；也兼容 invoke 直接返回字符串的情况
 *   （两种形状都可能出现在不同版本的后端实现里，这里做一次判断，不强绑定其一）。
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompleteTextOptions {
  messages: ChatMessage[]
  system?: string
  maxTokens: number
  /** 续写同一对话时置 true，吃提示词缓存 */
  cache?: boolean
  /** 取消句柄；不传则内部生成一个（后端参数必填，invoke 负载必须始终带上） */
  requestId?: string
}

/**
 * 组装 `ai_complete_text` 的 invoke 负载，与实际发起 invoke() 分离成纯函数——
 * Node 测试环境没有 IPC 桥，调用真实 invoke() 会直接因缺少 `window` 抛错（同
 * unwrapText/extractJson 已有的测试权衡），这里只让「负载长什么样」可以脱离
 * IPC 直接断言：requestId 未传时用 createUuid() 兜底生成，保证负载里这个后端
 * 必填字段永远非空。
 */
export function buildCompleteTextPayload(opts: CompleteTextOptions): {
  messages: ChatMessage[]
  system: string | undefined
  maxTokens: number
  cache: boolean
  requestId: string
} {
  return {
    messages: opts.messages,
    system: opts.system,
    maxTokens: opts.maxTokens,
    cache: opts.cache ?? false,
    requestId: opts.requestId ?? createUuid(),
  }
}

export async function completeText(opts: CompleteTextOptions): Promise<string> {
  const result = await invoke('ai_complete_text', buildCompleteTextPayload(opts))
  return unwrapText(result)
}

/** 取消一个进行中的请求（现有后端命令 ai_cancel，见 stream.rs） */
export async function cancelRequest(requestId: string): Promise<void> {
  await invoke('ai_cancel', buildCancelPayload(requestId))
}

/** cancelRequest 的 invoke 负载，同样拆成纯函数供测试直接断言形状 */
export function buildCancelPayload(requestId: string): { requestId: string } {
  return { requestId }
}

/** 后端返回形状目前有 { text } 与裸字符串两种可能，都接受。导出供 transport 契约测试直接验证。 */
export function unwrapText(result: unknown): string {
  if (typeof result === 'string') return result
  if (
    result &&
    typeof result === 'object' &&
    'text' in result &&
    typeof (result as { text: unknown }).text === 'string'
  ) {
    return (result as { text: string }).text
  }
  throw new Error('ai_complete_text 返回了无法识别的形状')
}

/**
 * 结构化输出的返回：解析后的数据之外，把「实际发送出去的最后一条 user 消息全文
 * （含拼接的 schema 附块）」和「模型的原始回复全文」一并带出来。
 *
 * 用途：generate.ts 的两阶段生成要把这一轮对话原样接到下一轮续写里（阶段一出题
 * → 明答校验 / 阶段二解析），只有拼回去的 user/assistant 文本与本轮实际发送、
 * 实际收到的逐字节一致，续写请求的前缀才能命中 prompt cache——重新用领域数据
 * 序列化出一份「看起来等价」的 JSON，措辞、字段顺序、空白都对不上，直接不命中。
 */
export interface StructuredCompletion<T> {
  data: T
  /** 实际发送的最后一条 user 消息全文（含拼接的 schema 附块） */
  requestMessage: string
  /** 模型的原始回复全文（未做 JSON 提取/解析） */
  rawResponse: string
}

/**
 * 结构化输出：schema 内嵌提示词（词卷兼容通道的原做法，也是 Lantern 惯例——
 * learning_card / xray 先例）→ 后端拿全文 → 前端 zod 校验 + extractJson 容错。
 * schema 说明拼进最后一条 user 消息（多轮续写场景下，schema 只约束"这一轮"要
 * 输出的内容，拼在触发这一轮输出的那条消息尾部最准确）。
 */
export async function completeStructured<S extends z.ZodType>(opts: {
  messages: ChatMessage[]
  system?: string
  schema: S
  maxTokens: number
  cache?: boolean
  /** 取消句柄；不传则 completeText 内部生成一个 */
  requestId?: string
}): Promise<StructuredCompletion<z.infer<S>>> {
  const { schema, messages } = opts
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    throw new Error('completeStructured 要求 messages 以一条 user 消息结尾')
  }
  const jsonSchema = z.toJSONSchema(schema)
  const last = messages[messages.length - 1]
  const requestMessage = `${last.content}

## 输出格式（硬性要求）
只输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码围栏。JSON 必须符合以下 JSON Schema：
${JSON.stringify(jsonSchema)}`
  const withInstruction: ChatMessage[] = [...messages.slice(0, -1), { role: 'user', content: requestMessage }]
  const text = await completeText({
    messages: withInstruction,
    system: opts.system,
    maxTokens: opts.maxTokens,
    cache: opts.cache,
    requestId: opts.requestId,
  })
  if (!text) throw new Error('模型返回了空响应')
  const data = schema.parse(JSON.parse(extractJson(text)))
  return { data, requestMessage, rawResponse: text }
}

/** 容错：模型没听话带了围栏或前后缀时，抠出第一个完整 JSON 对象（照搬词卷原实现） */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}
