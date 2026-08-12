import { describe, expect, it } from 'vitest'
import type { AnswerSheet, Quiz } from '../types'
import type { GrammarVerdict } from '../llm/judge'
import { gradeQuiz } from './grading'

function makeQuiz(): Quiz {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    config: {
      difficulty: 'cet6',
      types: ['reading', 'grammarFill'],
      materialSource: 'ai-original',
      model: 'demo',
      maskedCheck: false,
    },
    words: [
      { word: 'subsidy', origin: 'today' },
      { word: 'advocate', origin: 'today' },
    ],
    passages: [],
    readingQuestions: [
      {
        id: 'rq1',
        type: 'reading',
        passageId: 'p1',
        targetWord: 'subsidy',
        stem: 'stem',
        options: [],
        answer: 'A',
        explanation: '',
        source: { passageId: 'p1', paragraph: 1, quote: '' },
      },
    ],
    grammarQuestions: [
      {
        id: 'gq1',
        type: 'grammarFill',
        targetWord: 'advocate',
        sentence: 'sentence',
        hint: 'advocate',
        answer: 'have advocated',
        explanation: '',
      },
    ],
    status: 'ready',
  }
}

describe('gradeQuiz', () => {
  it('全对', () => {
    const quiz = makeQuiz()
    const answers: AnswerSheet = { rq1: 'A', gq1: 'have advocated' }
    const grammarVerdicts: GrammarVerdict[] = [{ questionId: 'gq1', correct: true }]
    const result = gradeQuiz(quiz, answers, grammarVerdicts)
    expect(result.score).toBe(2)
    expect(result.total).toBe(2)
    expect(result.wrongWords).toEqual([])
  })

  it('全错', () => {
    const quiz = makeQuiz()
    const answers: AnswerSheet = { rq1: 'B', gq1: 'advocate' }
    const grammarVerdicts: GrammarVerdict[] = [
      { questionId: 'gq1', correct: false, note: '拼写不符标准答案' },
    ]
    const result = gradeQuiz(quiz, answers, grammarVerdicts)
    expect(result.score).toBe(0)
    expect(result.total).toBe(2)
    expect([...result.wrongWords].sort()).toEqual(['advocate', 'subsidy'])
    const gqVerdict = result.verdicts.find((v) => v.questionId === 'gq1')
    expect(gqVerdict?.judgeNote).toBe('拼写不符标准答案')
  })

  it('未作答算错，userAnswer 记空串', () => {
    const quiz = makeQuiz()
    const result = gradeQuiz(quiz, {}, [])
    const rqVerdict = result.verdicts.find((v) => v.questionId === 'rq1')
    const gqVerdict = result.verdicts.find((v) => v.questionId === 'gq1')
    expect(rqVerdict).toMatchObject({ correct: false, userAnswer: '' })
    expect(gqVerdict).toMatchObject({ correct: false, userAnswer: '' })
  })

  it('语法题按传入的 LLM verdict 判定，并带上 judgeNote', () => {
    const quiz = makeQuiz()
    const answers: AnswerSheet = { gq1: 'has advocated' }
    const grammarVerdicts: GrammarVerdict[] = [
      { questionId: 'gq1', correct: true, note: '接受了变体时态' },
    ]
    const result = gradeQuiz(quiz, answers, grammarVerdicts)
    const gqVerdict = result.verdicts.find((v) => v.questionId === 'gq1')
    expect(gqVerdict?.correct).toBe(true)
    expect(gqVerdict?.judgeNote).toBe('接受了变体时态')
  })

  it('wrongWords 去重：同一考点词多道题都错只出现一次', () => {
    const quiz = makeQuiz()
    quiz.readingQuestions.push({
      id: 'rq2',
      type: 'reading',
      passageId: 'p1',
      targetWord: 'subsidy',
      stem: 'stem2',
      options: [],
      answer: 'A',
      explanation: '',
      source: { passageId: 'p1', paragraph: 1, quote: '' },
    })
    const answers: AnswerSheet = { rq1: 'B', rq2: 'B', gq1: 'have advocated' }
    const grammarVerdicts: GrammarVerdict[] = [{ questionId: 'gq1', correct: true }]
    const result = gradeQuiz(quiz, answers, grammarVerdicts)
    expect(result.wrongWords).toEqual(['subsidy'])
  })
})
