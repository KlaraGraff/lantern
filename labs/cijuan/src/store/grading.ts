import type { AnswerSheet, QuestionVerdict, Quiz, QuizResult } from '../types'
import type { GrammarVerdict } from '../llm/judge'

/**
 * 纯函数判分：不碰数据库、不调 LLM，方便测试。
 * 阅读题本地比对；语法题采用调用方已算好的 LLM 裁决（judgeGrammar 的输出）。
 */
export function gradeQuiz(
  quiz: Quiz,
  answers: AnswerSheet,
  grammarVerdicts: GrammarVerdict[],
): QuizResult {
  const verdicts: QuestionVerdict[] = []

  for (const q of quiz.readingQuestions) {
    const userAnswer = answers[q.id] ?? ''
    verdicts.push({
      questionId: q.id,
      targetWord: q.targetWord,
      correct: userAnswer === q.answer,
      userAnswer,
      correctAnswer: q.answer,
    })
  }

  const grammarById = new Map(grammarVerdicts.map((v) => [v.questionId, v]))
  for (const q of quiz.grammarQuestions) {
    const userAnswer = answers[q.id] ?? ''
    const verdict = grammarById.get(q.id)
    const item: QuestionVerdict = {
      questionId: q.id,
      targetWord: q.targetWord,
      correct: verdict?.correct ?? false,
      userAnswer,
      correctAnswer: q.answer,
    }
    if (verdict?.note) item.judgeNote = verdict.note
    verdicts.push(item)
  }

  const score = verdicts.filter((v) => v.correct).length
  const wrongWords = [...new Set(verdicts.filter((v) => !v.correct).map((v) => v.targetWord))]

  return {
    submittedAt: new Date().toISOString(),
    verdicts,
    score,
    total: verdicts.length,
    wrongWords,
  }
}
