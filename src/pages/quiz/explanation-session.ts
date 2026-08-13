/**
 * 阶段二（解析后台续写）的会话编排——词卷页与做题/评卷页之间的接缝。
 *
 * 为什么是模块级单例而不是组件状态：发卷后用户立刻从「生成中屏」跳到做题页，
 * 解析续写必须跨路由继续跑；跑完写回 content_json（update_quiz_paper_content），
 * 订阅方（做题/评卷页）收到状态翻转后重新拉取试卷即可，不需要在页面间传内存态。
 *
 * 评卷页据此渲染三种解析状态（样张 §E，文案规则 §H）：
 * - session.running                → 「这道题的讲解还在写」骨架屏
 * - !running 且该组解析缺失        → 「没写成 / 点击补生成」（含 App 重启后 session
 *   为 undefined 的冷启动情形——缺失本身就是失败的证据，不依赖内存态）
 * - 解析字段在                     → 正常展开
 *
 * 补生成走同一入口：runExplanationSession({ onlyPassageIds: [...] })，无 traces
 * 即冷启动重建（generateExplanations 内部已兜底）。
 */
import { invoke } from '@tauri-apps/api/core'
import { generateExplanations, type GenerationTrace } from '../../quiz/generate.ts'
import type { CompleteStructured } from '../../quiz/generate.ts'
import type { Quiz } from '../../quiz/types.ts'
import { quizContentJson } from './paper-io.ts'

export interface ExplanationSessionState {
  running: boolean
  /**
   * 本轮正在生成的组；不跑时为空数组。补生成单组时只有被点名的组在里面——
   * 三态判定据此只给这些组画骨架屏，已写完的组照常展开（不能整卷一起变骨架）。
   */
  runningPassageIds: string[]
  /** 最近一次运行后仍缺解析的组；running 期间保持上一次的值 */
  missingPassageIds: string[]
}

const sessions = new Map<number, ExplanationSessionState>()
const listeners = new Set<() => void>()

function setSession(paperId: number, state: ExplanationSessionState) {
  sessions.set(paperId, state)
  for (const fn of listeners) fn()
}

/** useSyncExternalStore 的 subscribe；返回退订函数。 */
export function subscribeExplanationSessions(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** useSyncExternalStore 的 getSnapshot；对象引用仅在状态变化时更换。 */
export function getExplanationSession(paperId: number): ExplanationSessionState | undefined {
  return sessions.get(paperId)
}

/** 只留给测试重置模块态用。 */
export function resetExplanationSessions() {
  sessions.clear()
}

/** 把整卷裁成只含指定文章组的子卷（补生成单组时避免重跑已成功的组）。 */
export function scopeQuiz(quiz: Quiz, passageIds: ReadonlySet<string>): Quiz {
  return {
    ...quiz,
    passages: quiz.passages.filter((p) => passageIds.has(p.id)),
    readingQuestions: quiz.readingQuestions.filter((q) => passageIds.has(q.passageId)),
    grammarQuestions: quiz.grammarQuestions.filter((q) => passageIds.has(q.passageId)),
  }
}

/** 把子卷上更新过的题（带解析字段）按 id 合并回整卷；文章与其余字段不动。 */
export function mergeQuizQuestions(full: Quiz, updated: Quiz): Quiz {
  const reading = new Map(updated.readingQuestions.map((q) => [q.id, q]))
  const grammar = new Map(updated.grammarQuestions.map((q) => [q.id, q]))
  return {
    ...full,
    readingQuestions: full.readingQuestions.map((q) => reading.get(q.id) ?? q),
    grammarQuestions: full.grammarQuestions.map((q) => grammar.get(q.id) ?? q),
  }
}

async function persistContent(paperId: number, quiz: Quiz): Promise<void> {
  await invoke('update_quiz_paper_content', { id: paperId, contentJson: quizContentJson(quiz) })
}

/**
 * 跑一轮解析生成并写回数据库。fire-and-forget 安全：内部不抛出，失败组记入
 * missingPassageIds。返回合并解析后的整卷（写库成功时），供直接调用方即时刷 UI；
 * 订阅方走「状态翻转 → 重新 get_quiz_paper」的路径，不依赖返回值。
 *
 * 同一张卷已有一轮在跑时直接返回 null（UI 在 running 期间不该给出第二个入口，
 * 这里再兜一层）。
 */
export async function runExplanationSession(opts: {
  paperId: number
  /** 整卷（不是子卷）；合并与写回都以它为底 */
  quiz: Quiz
  /** 阶段一续写凭据（刚生成完那一次才有），见 generate.ts GenerationTrace */
  traces?: GenerationTrace[]
  /** 只补这些组；省略 = 全部组（发卷后的首轮） */
  onlyPassageIds?: string[]
  /** 测试注入点，穿透给 generateExplanations */
  complete?: CompleteStructured
  /** 测试注入点，默认 update_quiz_paper_content */
  persist?: (paperId: number, quiz: Quiz) => Promise<void>
}): Promise<Quiz | null> {
  const { paperId, quiz } = opts
  const persist = opts.persist ?? persistContent

  const existing = sessions.get(paperId)
  if (existing?.running) return null

  const scopeIds = opts.onlyPassageIds
    ? new Set(opts.onlyPassageIds)
    : new Set(quiz.passages.map((p) => p.id))
  // 上一轮失败、这一轮没被点名的组，失败状态要保住，不能被这轮的成功清掉
  const carriedMissing = (existing?.missingPassageIds ?? []).filter((id) => !scopeIds.has(id))

  setSession(paperId, {
    running: true,
    runningPassageIds: [...scopeIds],
    missingPassageIds: existing?.missingPassageIds ?? [],
  })

  try {
    const scoped = opts.onlyPassageIds ? scopeQuiz(quiz, scopeIds) : quiz
    const { quiz: updatedScoped, missingPassageIds } = await generateExplanations({
      quiz: scoped,
      traces: opts.traces,
      complete: opts.complete,
    })
    const merged = mergeQuizQuestions(quiz, updatedScoped)
    await persist(paperId, merged)
    setSession(paperId, {
      running: false,
      runningPassageIds: [],
      missingPassageIds: [...carriedMissing, ...missingPassageIds],
    })
    return merged
  } catch (error) {
    // generateExplanations 按组吞错不抛；走到这里只剩写库失败——解析已生成但没
    // 落库，等价于整个 scope 都缺，让补生成按钮出现
    console.error('explanation session failed to persist:', error)
    setSession(paperId, {
      running: false,
      runningPassageIds: [],
      missingPassageIds: [...carriedMissing, ...scopeIds],
    })
    return null
  }
}
