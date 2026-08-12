import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Quiz, QuizResult } from '../types'
import { db } from './db'
import { getQuiz, listQuizzes, saveQuiz, submitQuiz } from './quizzes'

beforeEach(async () => {
  await db.quizzes.clear()
  await db.wrongWords.clear()
})

function makeQuiz(createdAt: string): Quiz {
  return {
    createdAt,
    config: {
      difficulty: 'cet6',
      types: ['reading'],
      materialSource: 'ai-original',
      model: 'demo',
      maskedCheck: false,
    },
    words: [{ word: 'subsidy', origin: 'today' }],
    passages: [],
    readingQuestions: [],
    grammarQuestions: [],
    status: 'ready',
  }
}

describe('saveQuiz / getQuiz / listQuizzes', () => {
  it('保存后可按 id 取回，列表按 createdAt 倒序', async () => {
    const id1 = await saveQuiz(makeQuiz('2026-01-01T00:00:00.000Z'))
    const id2 = await saveQuiz(makeQuiz('2026-01-02T00:00:00.000Z'))
    const got = await getQuiz(id1)
    expect(got?.words[0].word).toBe('subsidy')
    const all = await listQuizzes()
    expect(all.map((q) => q.id)).toEqual([id2, id1])
  })
})

describe('submitQuiz', () => {
  it('写入 status/result 并驱动错词池', async () => {
    const quizId = await saveQuiz(makeQuiz('2026-01-01T00:00:00.000Z'))
    const result: QuizResult = {
      submittedAt: '2026-01-01T00:10:00.000Z',
      verdicts: [
        { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
      ],
      score: 0,
      total: 1,
      wrongWords: ['subsidy'],
    }
    await submitQuiz(quizId, result)
    const quiz = await getQuiz(quizId)
    expect(quiz?.status).toBe('submitted')
    expect(quiz?.result?.score).toBe(0)
    const wrongEntries = await db.wrongWords.toArray()
    expect(wrongEntries).toHaveLength(1)
    expect(wrongEntries[0].word).toBe('subsidy')
  })

  it('对不存在的 quizId 抛错', async () => {
    await expect(submitQuiz(999, { submittedAt: '', verdicts: [], score: 0, total: 0, wrongWords: [] })).rejects.toThrow()
  })

  it('幂等：重复交同一张卷不重复累计 wrongCount', async () => {
    const quizId = await saveQuiz(makeQuiz('2026-01-01T00:00:00.000Z'))
    const result: QuizResult = {
      submittedAt: '2026-01-01T00:10:00.000Z',
      verdicts: [
        { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
      ],
      score: 0,
      total: 1,
      wrongWords: ['subsidy'],
    }
    await submitQuiz(quizId, result)
    await submitQuiz(quizId, result)
    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].wrongCount).toBe(1)
  })

  it('演示卷（config.demo）不写错词池', async () => {
    const quiz = makeQuiz('2026-01-01T00:00:00.000Z')
    quiz.config.demo = true
    const quizId = await saveQuiz(quiz)
    await submitQuiz(quizId, {
      submittedAt: '2026-01-01T00:10:00.000Z',
      verdicts: [
        { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
      ],
      score: 0,
      total: 1,
      wrongWords: ['subsidy'],
    })
    expect((await getQuiz(quizId))?.status).toBe('submitted')
    expect(await db.wrongWords.toArray()).toHaveLength(0)
  })

  it('错词身份大小写不敏感：Curb 与 curb 只占一条记录', async () => {
    const quiz = makeQuiz('2026-01-01T00:00:00.000Z')
    quiz.words = [{ word: 'Curb', origin: 'today' }]
    const quizId = await saveQuiz(quiz)
    await submitQuiz(quizId, {
      submittedAt: '2026-01-01T00:10:00.000Z',
      verdicts: [
        { questionId: 'rq1', targetWord: 'Curb', correct: false, userAnswer: 'B', correctAnswer: 'A' },
      ],
      score: 0,
      total: 1,
      wrongWords: ['Curb'],
    })
    const quiz2 = makeQuiz('2026-01-02T00:00:00.000Z')
    quiz2.words = [{ word: 'curb', origin: 'recur' }]
    const quizId2 = await saveQuiz(quiz2)
    await submitQuiz(quizId2, {
      submittedAt: '2026-01-02T00:10:00.000Z',
      verdicts: [
        { questionId: 'rq2', targetWord: 'curb', correct: false, userAnswer: 'C', correctAnswer: 'A' },
      ],
      score: 0,
      total: 1,
      wrongWords: ['curb'],
    })
    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].word).toBe('curb')
    expect(entries[0].wrongCount).toBe(2)
  })
})
