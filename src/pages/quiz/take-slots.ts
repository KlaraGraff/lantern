/**
 * 渐进发卷做题屏的槽位推导（docs/impls/quiz-progressive-delivery.md §五）。
 * 独立成纯函数模块：TakeView 是组件文件（react-refresh 要求组件文件只导出
 * 组件），且这里不碰 React，node 测试可以直接 import。
 *
 * 谁就绪谁开放：某篇 done 且能在 quiz.passages 里找到对应 passage，就是
 * open，可以做——与前面的篇是否就绪无关（不按篇序解锁，避免第 1 篇生成
 * 失败/还在重试就把已经写好的第 2 篇也锁住）。pending 与 failed 的分界看
 * 会话：会话在跑且该篇未终局是 pending；没有会话在跑（含重启后的冷启动，
 * 内存会话已死）一律 failed——「上次中断」和「生成失败」对用户是同一件事：
 * 这篇还没有，可以重新生成。
 */
import { isAiErrorCode, type AiErrorCode } from '../../utils/aiError.ts'
import type { Passage, Quiz } from '../../quiz/types.ts'
import type { GenerationSessionState } from './generation-session.ts'

export type SlotState = 'open' | 'pending' | 'failed'

/**
 * pending 槽位的活阶段，来自生成会话的按篇事件。'pending'（拆词建行到
 * 流水线首个事件之间的瞬时态）归入 writing——对用户它就是「开始写了」；
 * 'done'（已生成完、排队等落库，落库后槽位才翻 open）归入 checking——
 * 文章确实写完了，说「写稿中」反而是倒退。'retrying' 是整篇失败后的自动
 * 重试（最多 QUIZ_ARTICLE_MAX_ATTEMPTS 次），与「题目没过复核在重出」的
 * regenerating 是两回事，都要保留。
 */
export type PendingStep = 'writing' | 'checking' | 'regenerating' | 'retrying'

export interface PassageSlot {
  state: SlotState
  passage?: Passage
  wordCount: number
  /** 仅 state === 'pending' 时有值 */
  step?: PendingStep
  /** 仅 step === 'retrying' 时有值：当前是第几次尝试（1 起算） */
  attempt?: number
  /** 仅 state === 'failed' 时有值：识别得出的 AI 错误码，界面据此给现成文案 */
  errorCode?: AiErrorCode
  /** 仅 state === 'failed' 且错误码认不出时有值：失败原文（已截断） */
  errorMessage?: string
}

export function deriveSlots(
  quiz: Quiz,
  session: GenerationSessionState | undefined,
): PassageSlot[] {
  const plan = quiz.status === 'generating' ? quiz.generation : undefined
  if (!plan) return quiz.passages.map((p) => ({ state: 'open', passage: p, wordCount: 0 }))
  return plan.groups.map((g, i) => {
    const passage = g.passageId ? quiz.passages.find((p) => p.id === g.passageId) : undefined
    if (g.state === 'done' && passage) {
      return { state: 'open', passage, wordCount: g.words.length }
    }
    const live = session?.running ? session.articles[i]?.step : undefined
    if (session?.running && live !== 'failed') {
      if (live === 'retrying') {
        return {
          state: 'pending',
          wordCount: g.words.length,
          step: 'retrying',
          attempt: session.articles[i]?.attempt,
        }
      }
      const step: PendingStep =
        live === 'checking' || live === 'regenerating'
          ? live
          : live === 'done'
            ? 'checking'
            : 'writing'
      return { state: 'pending', wordCount: g.words.length, step }
    }
    // 失败原因随槽位带出：认得出的错误码给现成文案，认不出的给失败原文，
    // 两者都没有才退回「这一篇没生成完成」的通用说法
    return {
      state: 'failed',
      wordCount: g.words.length,
      errorCode: isAiErrorCode(g.errorCode) ? g.errorCode : undefined,
      errorMessage: g.errorMessage,
    }
  })
}
