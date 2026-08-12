import type { AiProfile, GrammarFillQuestion } from '../types'
import { callStructured } from './client'
import { buildGrammarJudgePrompt } from './prompts'
import { grammarJudgeSchema } from './schemas'

export interface GrammarVerdict {
  questionId: string
  correct: boolean
  note?: string
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * 语法填空判分：先本地比对（免费、即时），
 * 只有「填了内容但和标准答案不完全一致」的题才交给 LLM 裁决变体。
 * profile 为 null（演示模式）时跳过 LLM，一律按不一致判错。
 */
export async function judgeGrammar(opts: {
  profile: AiProfile | null
  questions: GrammarFillQuestion[]
  answers: Record<string, string>
}): Promise<GrammarVerdict[]> {
  const { questions, answers } = opts
  const verdicts: GrammarVerdict[] = []
  const pending: { question: GrammarFillQuestion; userAnswer: string; slot: number }[] = []

  for (const q of questions) {
    const userAnswer = answers[q.id] ?? ''
    if (normalize(userAnswer) === normalize(q.answer)) {
      verdicts.push({ questionId: q.id, correct: true })
    } else if (!userAnswer.trim() || !opts.profile) {
      verdicts.push({ questionId: q.id, correct: false })
    } else {
      pending.push({ question: q, userAnswer, slot: verdicts.length })
      verdicts.push({ questionId: q.id, correct: false }) // 占位，LLM 结果回填
    }
  }

  if (pending.length > 0 && opts.profile) {
    try {
      const result = await callStructured({
        profile: opts.profile,
        prompt: buildGrammarJudgePrompt(
          pending.map((p) => ({
            sentence: p.question.sentence,
            hint: p.question.hint,
            answer: p.question.answer,
            userAnswer: p.userAnswer,
          })),
        ),
        schema: grammarJudgeSchema,
        maxTokens: 4000,
      })
      for (const v of result.verdicts) {
        const p = pending[v.questionIndex]
        if (p) verdicts[p.slot] = { questionId: p.question.id, correct: v.correct, note: v.note }
      }
    } catch {
      // LLM 判分失败时保留本地判定（不一致=错），不阻塞交卷
    }
  }
  return verdicts
}
