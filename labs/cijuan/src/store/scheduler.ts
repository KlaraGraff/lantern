import type { QuizResult, QuizWord, WrongWordEntry } from '../types'
import { db } from './db'

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString()
}

/**
 * 交卷后按判分结果推进错词池状态机：
 * - 判错的词：入池或重置回 stage 0（+2 天），wrongCount+1；已出池的词重新入池。
 * - 判对且已在池中（未出池）的词：stage 0 → stage 1（+7 天）；stage 1 → 出池（cleared）。
 * - 判对但不在池中的词：不处理，不入池。
 * - 同一个词在同一张卷子里既对又错：按错处理（result.wrongWords 已由判分层保证去重与此优先级）。
 */
export async function applyResult(
  result: QuizResult,
  quizWords: QuizWord[],
  now: Date = new Date(),
): Promise<void> {
  const nowIso = now.toISOString()
  // 词条身份统一小写：Curb 和 curb 是同一个词，不许占两条记录
  const wrongWords = [...new Set(result.wrongWords.map((w) => w.toLowerCase()))]
  const wrongSet = new Set(wrongWords)

  for (const word of wrongWords) {
    const existing = await db.wrongWords.where('word').equals(word).first()
    if (existing) {
      await db.wrongWords.update(existing.id as number, {
        lastWrongAt: nowIso,
        stage: 0,
        nextDueAt: addDays(now, 2),
        wrongCount: existing.wrongCount + 1,
        cleared: false,
      })
    } else {
      const entry: WrongWordEntry = {
        word,
        wrongCount: 1,
        firstWrongAt: nowIso,
        lastWrongAt: nowIso,
        stage: 0,
        nextDueAt: addDays(now, 2),
        cleared: false,
      }
      await db.wrongWords.add(entry)
    }
  }

  // 判对的词：从本卷考点词里挑出（排除本卷判错的），仅推进已在池中且未出池的
  const correctTargetWords = new Set(
    result.verdicts.filter((v) => v.correct).map((v) => v.targetWord.toLowerCase()),
  )
  const correctWords = [
    ...new Set(
      quizWords
        .map((w) => w.word.toLowerCase())
        .filter((w) => correctTargetWords.has(w) && !wrongSet.has(w)),
    ),
  ]

  for (const word of correctWords) {
    const existing = await db.wrongWords.where('word').equals(word).first()
    if (!existing || existing.cleared) continue // 不在池中：不处理
    if (existing.stage === 0) {
      await db.wrongWords.update(existing.id as number, { stage: 1, nextDueAt: addDays(now, 7) })
    } else {
      await db.wrongWords.update(existing.id as number, { cleared: true, nextDueAt: null })
    }
  }
}

/** 到期需要重现的错词：未出池且 nextDueAt <= now */
export async function getDueWords(now: Date = new Date()): Promise<WrongWordEntry[]> {
  const nowIso = now.toISOString()
  const all = await db.wrongWords.toArray()
  return all.filter((e) => !e.cleared && e.nextDueAt !== null && e.nextDueAt <= nowIso)
}

/** 全部错词条目（含已出池，供表格展示状态），按最近答错时间倒序 */
export async function listWrongWords(): Promise<WrongWordEntry[]> {
  const all = await db.wrongWords.toArray()
  return all.sort((a, b) => (a.lastWrongAt < b.lastWrongAt ? 1 : -1))
}

/** 清空错词池 */
export async function clearAllWrongWords(): Promise<void> {
  await db.wrongWords.clear()
}
