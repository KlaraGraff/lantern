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

export interface PassageSlot {
  state: SlotState
  passage?: Passage
  wordCount: number
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
    const state: SlotState = session?.running && live !== 'failed' ? 'pending' : 'failed'
    return { state, wordCount: g.words.length }
  })
}
