import type { AskThread, Quiz, QuizResult } from '../types'
import { db } from './db'
import { applyResult } from './scheduler'

export async function saveQuiz(quiz: Quiz): Promise<number> {
  return db.quizzes.add(quiz)
}

export async function getQuiz(id: number): Promise<Quiz | undefined> {
  return db.quizzes.get(id)
}

/** 全部试卷，createdAt 倒序 */
export async function listQuizzes(): Promise<Quiz[]> {
  const all = await db.quizzes.toArray()
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** 保存整卷的追问记录（每次线程有新消息就整体覆写，量小无需增量） */
export async function saveAskThreads(quizId: number, askThreads: AskThread[]): Promise<void> {
  await db.quizzes.update(quizId, { askThreads })
}

/**
 * 交卷：写入判分结果，并驱动错词池调度（quizWords 从库里已存的 quiz.words 取）。
 * - 幂等：已交过的卷直接返回，防止失败重试把 wrongCount 记两次、把词提前推出池。
 * - 事务：状态更新与错词池推进要么都成，要么都不成。
 * - 演示卷（config.demo）不碰错词池：样卷的词不许污染真实数据。
 */
export async function submitQuiz(quizId: number, result: QuizResult): Promise<void> {
  await db.transaction('rw', db.quizzes, db.wrongWords, async () => {
    const quiz = await db.quizzes.get(quizId)
    if (!quiz) throw new Error(`quiz ${quizId} not found`)
    if (quiz.status === 'submitted') return
    await db.quizzes.update(quizId, { status: 'submitted', result })
    if (!quiz.config.demo) await applyResult(result, quiz.words)
  })
}
