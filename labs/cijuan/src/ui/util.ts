import { createElement, type ReactNode } from 'react'
import type { AnswerSheet, Difficulty } from '../types'
import { wordFormsRegex } from '../llm'

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  cet4: 'CET-4',
  cet6: 'CET-6',
  ielts: '雅思',
  kaoyan: '考研',
}

/** 中文短日期，如「8月14日」 */
export function formatDateCN(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 带年份的短日期，历史卷列表用，如「2026-08-12」 */
export function formatDateISO(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 把引句中目标词（及常见屈折）包一层 <mark> 高亮（评卷页溯源块用）；.ts 文件不支持 JSX 语法，用 createElement */
export function highlightWord(quote: string, word: string): ReactNode {
  const re = wordFormsRegex(word)
  const m = re.exec(quote)
  if (!m) return quote
  return [quote.slice(0, m.index), createElement('mark', { key: 'hl' }, m[0]), quote.slice(m.index + m[0].length)]
}

const draftKey = (quizId: number | undefined) => `cijuan:draft:${quizId ?? 'temp'}`

/** 试卷「存草稿」：只是把作答暂存本地，不经过存储层契约（草稿不是领域数据） */
export function saveDraft(quizId: number | undefined, answers: AnswerSheet): void {
  try {
    localStorage.setItem(draftKey(quizId), JSON.stringify(answers))
  } catch {
    // 存不进去就算了，不影响做题
  }
}

export function loadDraft(quizId: number | undefined): AnswerSheet | null {
  try {
    const raw = localStorage.getItem(draftKey(quizId))
    return raw ? (JSON.parse(raw) as AnswerSheet) : null
  } catch {
    return null
  }
}

export function clearDraft(quizId: number | undefined): void {
  try {
    localStorage.removeItem(draftKey(quizId))
  } catch {
    // 忽略
  }
}
