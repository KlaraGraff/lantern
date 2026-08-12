import type { GrammarFillQuestion } from './types.ts'
import { buildGrammarJudgePrompt } from './prompts.ts'
import { grammarJudgeSchema } from './schemas.ts'
import { completeStructured } from './transport.ts'

export interface GrammarVerdict {
  questionId: string
  correct: boolean
  note?: string
}

/** 答案比对的标准化：大小写、首尾空格、内部多余空格不影响判定。generate.ts 的明答校验复用。 */
export const normalizeAnswer = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * 语法填空判分：先本地比对（免费、即时），
 * 只有「填了内容但和标准答案不完全一致」的题才交给 LLM 裁决变体。
 *
 * 迁自 labs/cijuan/src/llm/judge.ts。原版用 `profile: AiProfile | null`
 * 区分演示模式（null 时跳过 LLM）；Lantern 前端不再持有服务商 profile
 * （路由在后端 ai_complete_text 内部完成），改用显式的 `demo` 标记。
 */
export async function judgeGrammar(opts: {
  questions: GrammarFillQuestion[]
  answers: Record<string, string>
  /** 演示卷：跳过 LLM 裁决，不一致一律判错（demo 卷不该产生真实用量） */
  demo?: boolean
}): Promise<GrammarVerdict[]> {
  const { questions, answers, demo } = opts
  const verdicts: GrammarVerdict[] = []
  const pending: { question: GrammarFillQuestion; userAnswer: string; slot: number }[] = []

  for (const q of questions) {
    const userAnswer = answers[q.id] ?? ''
    if (normalizeAnswer(userAnswer) === normalizeAnswer(q.answer)) {
      verdicts.push({ questionId: q.id, correct: true })
    } else if (!userAnswer.trim() || demo) {
      verdicts.push({ questionId: q.id, correct: false })
    } else {
      pending.push({ question: q, userAnswer, slot: verdicts.length })
      verdicts.push({ questionId: q.id, correct: false }) // 占位，LLM 结果回填
    }
  }

  if (pending.length > 0) {
    try {
      const { data: result } = await completeStructured({
        messages: [
          {
            role: 'user',
            content: buildGrammarJudgePrompt(
              pending.map((p) => ({
                sentence: p.question.sentence,
                hint: p.question.hint,
                answer: p.question.answer,
                userAnswer: p.userAnswer,
              })),
            ),
          },
        ],
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
