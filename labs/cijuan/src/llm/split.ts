import { WORDS_PER_PASSAGE, type QuizWord } from '../types'

/**
 * 把一批词分组，每组对应一篇文章。
 * 规则：每篇最多 12 词（硬上限），组间尽量均衡；
 * 词太少或数量尴尬时允许低于 8 词的目标下限。
 */
export function splitWords(words: QuizWord[]): QuizWord[][] {
  if (words.length === 0) return []
  const groupCount = Math.ceil(words.length / WORDS_PER_PASSAGE.max)
  const base = Math.floor(words.length / groupCount)
  const remainder = words.length % groupCount
  const groups: QuizWord[][] = []
  let cursor = 0
  for (let i = 0; i < groupCount; i++) {
    const size = base + (i < remainder ? 1 : 0)
    groups.push(words.slice(cursor, cursor + size))
    cursor += size
  }
  return groups
}

/**
 * 解析用户粘贴的词表：按换行/逗号/顿号/分号/制表符切分，去重、去空。
 * 空格**不是**分隔符——「in particular」「take over」这类搭配是一个考点，
 * 一项内的空格属于词组本身（多余空格压成一个）。
 * 代价：一行里用空格隔开多个词的粘贴方式不支持，需一行一词或用逗号。
 */
export function parseWordInput(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of raw.split(/[\n\r\t,，、;；]+/)) {
    const word = stripListMarker(piece.trim()).replace(/\s+/g, ' ')
    // 不含字母的碎片（纯序号、纯标点）不是词，丢弃
    if (!word || !/[a-z]/i.test(word)) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

/**
 * 剥掉每一项行首的序号/项目符号：「2. particular」「(3) curb」「- subsidy」。
 * 数字后必须跟标点或空格才算序号——「2nd」这类词本身不受影响。
 */
function stripListMarker(piece: string): string {
  return piece
    .replace(/^[-•*·]+\s*/, '')
    .replace(/^[(（]?\d{1,3}(?:[)）.．]+\s*|\s+)/, '')
}

/**
 * 缺乏考察意义的功能词：冠词、代词、be/助动词、基础介词连词。
 * 单独出现时无法按「不认识就答不出」的标准出题；只判定单词，
 * 词组（in particular、take over）里的 in/over 不受影响。
 */
const WEAK_WORDS = new Set([
  'a', 'an', 'the',
  'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'we', 'us', 'our', 'they', 'them', 'their',
  'this', 'that', 'these', 'those',
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'do', 'does', 'did', 'not', 'no',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'up', 'out',
  'and', 'or', 'but', 'so', 'if', 'as',
])

export function isWeakWord(word: string): boolean {
  const w = word.toLowerCase().trim()
  return !w.includes(' ') && WEAK_WORDS.has(w)
}
