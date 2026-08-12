import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { QuizResult, QuizWord } from '../types'
import { db } from './db'
import { applyResult, clearAllWrongWords, getDueWords, listWrongWords } from './scheduler'

const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(async () => {
  await db.wrongWords.clear()
  await db.quizzes.clear()
})

function makeResult(overrides: Partial<QuizResult> = {}): QuizResult {
  return {
    submittedAt: '2026-01-01T00:00:00.000Z',
    verdicts: [],
    score: 0,
    total: 0,
    wrongWords: [],
    ...overrides,
  }
}

describe('scheduler / applyResult', () => {
  it('新错词入池：stage 0，nextDueAt = +2 天，wrongCount = 1', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const words: QuizWord[] = [{ word: 'subsidy', origin: 'today' }]
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
        ],
        wrongWords: ['subsidy'],
      }),
      words,
      now,
    )
    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ word: 'subsidy', wrongCount: 1, stage: 0, cleared: false })
    expect(entries[0].firstWrongAt).toBe(now.toISOString())
    expect(entries[0].lastWrongAt).toBe(now.toISOString())
    expect(entries[0].nextDueAt).toBe(new Date(now.getTime() + 2 * DAY_MS).toISOString())
  })

  it('stage0 答对升 stage1，nextDueAt = +7 天', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const words: QuizWord[] = [{ word: 'subsidy', origin: 'recur' }]
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
        ],
        wrongWords: ['subsidy'],
      }),
      words,
      t0,
    )

    const t1 = new Date('2026-01-03T00:00:00.000Z')
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: true, userAnswer: 'A', correctAnswer: 'A' },
        ],
        wrongWords: [],
      }),
      words,
      t1,
    )

    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].stage).toBe(1)
    expect(entries[0].cleared).toBe(false)
    expect(entries[0].nextDueAt).toBe(new Date(t1.getTime() + 7 * DAY_MS).toISOString())
  })

  it('stage1 答对出池：cleared = true，nextDueAt = null', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    await db.wrongWords.add({
      word: 'subsidy',
      wrongCount: 1,
      firstWrongAt: t0.toISOString(),
      lastWrongAt: t0.toISOString(),
      stage: 1,
      nextDueAt: new Date(t0.getTime() + 7 * DAY_MS).toISOString(),
      cleared: false,
    })
    const words: QuizWord[] = [{ word: 'subsidy', origin: 'recur' }]
    const t1 = new Date('2026-01-08T00:00:00.000Z')
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: true, userAnswer: 'A', correctAnswer: 'A' },
        ],
        wrongWords: [],
      }),
      words,
      t1,
    )
    const entries = await db.wrongWords.toArray()
    expect(entries[0].cleared).toBe(true)
    expect(entries[0].nextDueAt).toBeNull()
  })

  it('出池后再答错：重新入池 stage0，wrongCount 累加', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    await db.wrongWords.add({
      word: 'subsidy',
      wrongCount: 2,
      firstWrongAt: t0.toISOString(),
      lastWrongAt: t0.toISOString(),
      stage: 1,
      nextDueAt: null,
      cleared: true,
    })
    const words: QuizWord[] = [{ word: 'subsidy', origin: 'today' }]
    const t1 = new Date('2026-02-01T00:00:00.000Z')
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: false, userAnswer: 'B', correctAnswer: 'A' },
        ],
        wrongWords: ['subsidy'],
      }),
      words,
      t1,
    )
    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].stage).toBe(0)
    expect(entries[0].cleared).toBe(false)
    expect(entries[0].wrongCount).toBe(3)
    expect(entries[0].firstWrongAt).toBe(t0.toISOString()) // 老词不重置首次答错时间
    expect(entries[0].lastWrongAt).toBe(t1.toISOString())
    expect(entries[0].nextDueAt).toBe(new Date(t1.getTime() + 2 * DAY_MS).toISOString())
  })

  it('同一张卷子里既对又错：按错处理，不推进 stage', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const words: QuizWord[] = [{ word: 'subsidy', origin: 'today' }]
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'subsidy', correct: true, userAnswer: 'A', correctAnswer: 'A' },
          { questionId: 'gq1', targetWord: 'subsidy', correct: false, userAnswer: 'x', correctAnswer: 'y' },
        ],
        wrongWords: ['subsidy'],
      }),
      words,
      t0,
    )
    const entries = await db.wrongWords.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].stage).toBe(0)
    expect(entries[0].cleared).toBe(false)
    expect(entries[0].wrongCount).toBe(1)
  })

  it('判对但不在池中：不入池', async () => {
    const words: QuizWord[] = [{ word: 'brandNew', origin: 'today' }]
    await applyResult(
      makeResult({
        verdicts: [
          { questionId: 'rq1', targetWord: 'brandNew', correct: true, userAnswer: 'A', correctAnswer: 'A' },
        ],
        wrongWords: [],
      }),
      words,
      new Date('2026-01-01T00:00:00.000Z'),
    )
    expect(await db.wrongWords.toArray()).toHaveLength(0)
  })
})

describe('getDueWords', () => {
  it('只返回未出池且到期（nextDueAt <= now）的词', async () => {
    const now = new Date('2026-01-10T00:00:00.000Z')
    await db.wrongWords.bulkAdd([
      {
        word: 'due',
        wrongCount: 1,
        firstWrongAt: now.toISOString(),
        lastWrongAt: now.toISOString(),
        stage: 0,
        nextDueAt: now.toISOString(),
        cleared: false,
      },
      {
        word: 'notDueYet',
        wrongCount: 1,
        firstWrongAt: now.toISOString(),
        lastWrongAt: now.toISOString(),
        stage: 0,
        nextDueAt: new Date(now.getTime() + DAY_MS).toISOString(),
        cleared: false,
      },
      {
        word: 'clearedButPastDue',
        wrongCount: 1,
        firstWrongAt: now.toISOString(),
        lastWrongAt: now.toISOString(),
        stage: 1,
        nextDueAt: null,
        cleared: true,
      },
    ])
    const due = await getDueWords(now)
    expect(due.map((e) => e.word)).toEqual(['due'])
  })
})

describe('listWrongWords', () => {
  it('返回全部条目（含已出池），按 lastWrongAt 倒序', async () => {
    await db.wrongWords.bulkAdd([
      {
        word: 'earlier',
        wrongCount: 1,
        firstWrongAt: '2026-01-01T00:00:00.000Z',
        lastWrongAt: '2026-01-01T00:00:00.000Z',
        stage: 0,
        nextDueAt: '2026-01-03T00:00:00.000Z',
        cleared: false,
      },
      {
        word: 'later',
        wrongCount: 1,
        firstWrongAt: '2026-01-05T00:00:00.000Z',
        lastWrongAt: '2026-01-05T00:00:00.000Z',
        stage: 1,
        nextDueAt: null,
        cleared: true,
      },
    ])
    const all = await listWrongWords()
    expect(all.map((e) => e.word)).toEqual(['later', 'earlier'])
  })
})

describe('clearAllWrongWords', () => {
  it('清空错词池', async () => {
    await db.wrongWords.add({
      word: 'a',
      wrongCount: 1,
      firstWrongAt: '2026-01-01T00:00:00.000Z',
      lastWrongAt: '2026-01-01T00:00:00.000Z',
      stage: 0,
      nextDueAt: '2026-01-03T00:00:00.000Z',
      cleared: false,
    })
    await clearAllWrongWords()
    expect(await db.wrongWords.toArray()).toHaveLength(0)
  })
})
