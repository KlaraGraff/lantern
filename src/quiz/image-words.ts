import { z } from 'zod'
import { completeStructured, type ChatMessage } from './transport.ts'
import { parseWordInput } from './split.ts'
import { getAiErrorCode, type AiErrorCode } from '../utils/aiError.ts'

/**
 * 图片取词（docs/impls/quiz-image-words.md）：出卷页「今天的词」输入框粘贴/
 * 拖入的截图 → 出题模型提词 → 追加进输入框。这里是纯逻辑层：消息构造、
 * 提取调用、与既有文本的去重合并、错误分类；UI（chips/横幅/高亮）在
 * SetupTab。
 */

/** 一次识别的输出上限：一屏截图的词表远小于此，够而不浪费。 */
export const EXTRACT_MAX_TOKENS = 4000

const EXTRACTION_PROMPT = `这张图片是背单词/学英语时的截图（生词表、单词软件界面、笔记等）。把图里「正在学习的英语单词或词组」提取出来：
- 只要英文词条本身；中文释义、音标、例句、软件界面上的按钮文字都不要。
- 保持词条原本的拼写；普通单词用小写，专有名词保留大写。
- 词组（如 in particular、take over）算一个词条。
- 图里没有可提取的词就返回空数组，不要编造。`

const extractionSchema = z.object({
  words: z.array(z.string()),
})

/**
 * 提取请求的消息形状，拆成纯函数供测试断言：一条 user_image（data URI）
 * + 一条收尾的 user 提示词（completeStructured 要求以 user 结尾，schema
 * 附块也拼在这条上）。
 */
export function buildExtractionMessages(dataUri: string): ChatMessage[] {
  return [
    { role: 'user_image', content: dataUri },
    { role: 'user', content: EXTRACTION_PROMPT },
  ]
}

/** 识别一张图。词按模型返回的顺序原样带出，去重交给 mergeExtractedWords。 */
export async function extractWordsFromImage(
  dataUri: string,
  profileId: string | undefined,
): Promise<string[]> {
  const { data } = await completeStructured({
    messages: buildExtractionMessages(dataUri),
    schema: extractionSchema,
    maxTokens: EXTRACT_MAX_TOKENS,
    profileId,
  })
  return data.words
}

export interface MergeResult {
  /** 合并后的输入框全文 */
  nextRaw: string
  /** 实际追加的文本段（含前面的换行分隔符不算在内），用于选区高亮定位 */
  appendedText: string
  /** 新加进去的词数 */
  addedCount: number
  /** 与框内已有词重复、没有再加的词数（批内自身重复不计） */
  dupCount: number
}

/**
 * 把提取出的词追加进输入框文本：与既有词（按 parseWordInput 的切分口径）
 * 小写去重，新词一行一个接在末尾。输入框仍是唯一事实源——这里只产出
 * 新文本，不碰任何别的状态。
 *
 * 模型返回的每一项也先过一遍 parseWordInput 归一化——模型偶尔会带上
 * 行首序号（「1. apple」）或把几个词塞进一项（「banana, cherry」），
 * 不归一化的话查重口径与既有词对不上：框里出现字面的「1. apple」，
 * 汇总数字也报错（互审 F4）。
 */
export function mergeExtractedWords(existingRaw: string, words: string[]): MergeResult {
  const existing = new Set(parseWordInput(existingRaw).map((w) => w.toLowerCase()))
  const seen = new Set<string>()
  const added: string[] = []
  let dupCount = 0
  for (const raw of words) {
    for (const word of parseWordInput(raw)) {
      const key = word.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (existing.has(key)) {
        dupCount += 1
        continue
      }
      added.push(word)
    }
  }
  const appendedText = added.join('\n')
  const trimmed = existingRaw.replace(/\s+$/, '')
  const nextRaw =
    added.length === 0 ? existingRaw : trimmed === '' ? appendedText : `${trimmed}\n${appendedText}`
  return { nextRaw, appendedText, addedCount: added.length, dupCount }
}

export type ExtractFailure =
  /** 出题模型看不了图（或对图片请求直接 4xx）：换模型才能解决 */
  | { kind: 'vision' }
  /** 路由/配置类错误，沿用现有 AI 错误文案（aiErrorMessageKey） */
  | { kind: 'ai'; code: AiErrorCode }
  /** 其余（网络、超时、流中断……）：chip 上留重试 */
  | { kind: 'generic' }

/**
 * 识别失败的分类。后端把 provider 错误消毒成 `type=`/`code=` token（自由
 * 文本不透传），所以「模型不支持看图」没有稳定的错误码可查——用启发式：
 * 错误串点名 image/vision/multimodal，或对这个已知形状正确、体积很小的
 * 请求返回 400/413/422，都归为「换模型」。代价是极少数别因的 4xx 也会
 * 指去设置，但横幅旁的 chip 始终留着重试，走不进死胡同。
 */
export function classifyExtractError(error: unknown): ExtractFailure {
  const code = getAiErrorCode(error)
  if (code) return { kind: 'ai', code }
  const message = String(error)
  if (/image|vision|multimodal/i.test(message)) return { kind: 'vision' }
  if (/AI_PROVIDER_HTTP\b.*status=4(?:00|13|22)\b/.test(message)) return { kind: 'vision' }
  return { kind: 'generic' }
}
