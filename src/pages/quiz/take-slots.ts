/**
 * 渐进发卷做题屏的槽位推导（docs/impls/quiz-progressive-delivery.md §五）。
 * 独立成纯函数模块：TakeView 是组件文件（react-refresh 要求组件文件只导出
 * 组件），且这里不碰 React，node 测试可以直接 import。
 *
 * 按篇解锁 + 槽位状态推导。open 的判据是「本篇 done 且此前每一篇都 done」——
 * 锁的是做题顺序，与生成完成的先后无关。pending 与 failed 的分界看会话：
 * 会话在跑且该篇未终局是 pending；没有会话在跑（含重启后的冷启动，内存会话
 * 已死）一律 failed——「上次中断」和「生成失败」对用户是同一件事：这篇还
 * 没有，可以重新生成。
 */
import type { Passage, Quiz } from '../../quiz/types.ts'
import type { GenerationSessionState } from './generation-session.ts'

export type SlotState = 'open' | 'locked' | 'pending' | 'failed'

/**
 * pending 槽位的活阶段，来自生成会话的按篇事件。'pending'（拆词建行到
 * 流水线首个事件之间的瞬时态）归入 writing——对用户它就是「开始写了」；
 * 'done'（已生成完、排队等落库，落库后槽位才翻 open）归入 checking——
 * 文章确实写完了，说「写稿中」反而是倒退。
 */
export type PendingStep = 'writing' | 'checking' | 'regenerating'

export interface PassageSlot {
  state: SlotState
  passage?: Passage
  wordCount: number
  /** 仅 state === 'pending' 时有值 */
  step?: PendingStep
}

export function deriveSlots(
  quiz: Quiz,
  session: GenerationSessionState | undefined,
): PassageSlot[] {
  const plan = quiz.status === 'generating' ? quiz.generation : undefined
  if (!plan) return quiz.passages.map((p) => ({ state: 'open', passage: p, wordCount: 0 }))
  let prefixDone = true
  return plan.groups.map((g, i) => {
    const passage = g.passageId ? quiz.passages.find((p) => p.id === g.passageId) : undefined
    if (g.state === 'done' && passage) {
      const state: SlotState = prefixDone ? 'open' : 'locked'
      return { state, passage, wordCount: g.words.length }
    }
    prefixDone = false
    const live = session?.running ? session.articles[i]?.step : undefined
    if (session?.running && live !== 'failed') {
      const step: PendingStep =
        live === 'checking' || live === 'regenerating'
          ? live
          : live === 'done'
            ? 'checking'
            : 'writing'
      return { state: 'pending', wordCount: g.words.length, step }
    }
    return { state: 'failed', wordCount: g.words.length }
  })
}
