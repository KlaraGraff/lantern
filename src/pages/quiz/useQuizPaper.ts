/**
 * 词卷试卷页的数据层：加载/提交/持久化一张卷，外加阶段二解析会话的订阅与三态判定。
 *
 * 解析三态判定（评卷页据此渲染，样张 §E，见 explanation-session.ts 模块头注释）：
 * - running 且该组在本轮 scope 里 → 「讲解还在写」骨架屏（按组，不整卷一起变）
 * - !running 且该组缺解析字段     → 「没写成 / 点击补生成」（含冷启动 session
 *   为 undefined 的情形——缺失本身就是失败的证据，不依赖内存态）
 * - 该组字段都在                  → 正常展开
 *
 * 「该组缺解析字段」按 passageId 分组判定：阶段二解析是整组一次调用产出的，
 * 组内任一题缺字段即整组缺（generateExplanations 对失败组不写入任何字段）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { rowToQuiz, type QuizPaperRow } from './paper-io.ts'
import {
  getExplanationSession,
  runExplanationSession,
  subscribeExplanationSessions,
  type ExplanationSessionState,
} from './explanation-session.ts'
import type {
  AskThread,
  GrammarFillQuestion,
  Quiz,
  QuizResult,
  ReadingQuestion,
} from '../../quiz/types.ts'

export type QuizPaperLoadStatus = 'loading' | 'loaded' | 'not-found'

export interface UseQuizPaperResult {
  quiz: Quiz | null
  status: QuizPaperLoadStatus
  reload: () => Promise<void>
  submit: (result: QuizResult) => Promise<void>
  saveAskThreads: (threads: AskThread[]) => Promise<void>
  explanationSession: ExplanationSessionState | undefined
  /** 触发补生成：只重跑点名的文章组（含其语法题）。running 期间调用被契约模块自身挡掉。 */
  regenerateExplanations: (passageIds: string[]) => void
}

export function useQuizPaper(paperId: number | null): UseQuizPaperResult {
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [status, setStatus] = useState<QuizPaperLoadStatus>('loading')

  // 最新请求胜出：load 只在自己仍是最新一次快照写入方时落盘；submit/saveAskThreads
  // 直接改快照后也各自 +1，作废还在飞的 load——否则解析完成触发的静默刷新若在
  // 交卷之后才返回，会拿旧的 ready 行把已交卷的快照顶回去（评卷页被弹回做题页）。
  const snapshotSeqRef = useRef(0)

  // silent：换掉快照但不动 status。解析写完后的刷新走这条路——若先打回
  // 'loading'，QuizPaper 会整页换成占位 div，TakeView 被卸载，用户做到一半
  // 的答案（组件内部 state）全丢。静默刷新失败时保留旧快照，旧数据仍可用。
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (paperId == null || !Number.isFinite(paperId)) {
        setStatus('not-found')
        setQuiz(null)
        return
      }
      if (!opts?.silent) setStatus('loading')
      const seq = ++snapshotSeqRef.current
      try {
        const row = await invoke<QuizPaperRow | null>('get_quiz_paper', { id: paperId })
        if (seq !== snapshotSeqRef.current) return
        if (!row) {
          setQuiz(null)
          setStatus('not-found')
          return
        }
        setQuiz(rowToQuiz(row))
        setStatus('loaded')
      } catch (error) {
        console.error('get_quiz_paper failed:', error)
        if (opts?.silent) return
        setQuiz(null)
        setStatus('not-found')
      }
    },
    [paperId],
  )

  useEffect(() => {
    void load()
  }, [load])

  const explanationSession = useSyncExternalStore(
    subscribeExplanationSessions,
    () => (paperId == null ? undefined : getExplanationSession(paperId)),
    () => undefined,
  )

  // running: true → false 翻转时重新拉取整卷——解析已经写库（persistContent），
  // 但本地的 quiz 快照还是旧的，只有重新 get_quiz_paper 才能看见新字段。
  // 必须 silent：这个翻转常发生在用户还在做题时（TakeView 挂着）。
  const prevRunningRef = useRef(false)
  useEffect(() => {
    const running = explanationSession?.running ?? false
    if (prevRunningRef.current && !running) void load({ silent: true })
    prevRunningRef.current = running
  }, [explanationSession, load])

  const submit = useCallback(
    async (result: QuizResult) => {
      if (paperId == null) return
      const row = await invoke<QuizPaperRow>('submit_quiz_paper', {
        id: paperId,
        resultJson: JSON.stringify(result),
      })
      snapshotSeqRef.current += 1
      setQuiz(rowToQuiz(row))
    },
    [paperId],
  )

  const saveAskThreads = useCallback(
    async (threads: AskThread[]) => {
      if (paperId == null) return
      await invoke('save_quiz_ask_threads', { id: paperId, askThreadsJson: JSON.stringify(threads) })
      snapshotSeqRef.current += 1
      setQuiz((cur) => (cur ? { ...cur, askThreads: threads } : cur))
    },
    [paperId],
  )

  const regenerateExplanations = useCallback(
    (passageIds: string[]) => {
      if (paperId == null || !quiz || passageIds.length === 0) return
      void runExplanationSession({ paperId, quiz, onlyPassageIds: passageIds })
    },
    [paperId, quiz],
  )

  return { quiz, status, reload: load, submit, saveAskThreads, explanationSession, regenerateExplanations }
}

// ===== 纯函数（供组件与测试直接调用，不依赖 React） =====

/** 阅读题是否已有阶段二解析字段——任一字段在即算（同一次调用整组一起写）。 */
export function readingHasExplanation(q: ReadingQuestion): boolean {
  return (
    q.stemTranslation !== undefined ||
    q.howToSolve !== undefined ||
    q.wordNote !== undefined ||
    q.options.some((o) => o.meaning !== undefined || o.note !== undefined)
  )
}

/** 语法填空题是否已有阶段二解析字段，同上。 */
export function grammarHasExplanation(q: GrammarFillQuestion): boolean {
  return (
    q.sentenceTranslation !== undefined ||
    (q.grammarPoints?.length ?? 0) > 0 ||
    (q.reasoning?.length ?? 0) > 0 ||
    (q.wrongForms?.length ?? 0) > 0 ||
    q.wordMeaning !== undefined
  )
}

/** 一个文章组（passageId）里只要有一道题缺解析字段，整组就算缺。 */
export function groupExplanationMissing(quiz: Quiz, passageId: string): boolean {
  const reading = quiz.readingQuestions.filter((q) => q.passageId === passageId)
  const grammar = quiz.grammarQuestions.filter((q) => q.passageId === passageId)
  if (reading.length === 0 && grammar.length === 0) return false
  return reading.some((q) => !readingHasExplanation(q)) || grammar.some((q) => !grammarHasExplanation(q))
}

export type ExplanationTriState = 'running' | 'missing' | 'ready'

/**
 * 评卷页每题渲染前先问这个：running 优先于缺失判定，缺失优先于展示。
 * running 按组判定（runningPassageIds）——补生成单组时，只有被点名的组画
 * 骨架屏，已写完的组照常展开。
 */
export function explanationTriState(
  session: ExplanationSessionState | undefined,
  quiz: Quiz,
  passageId: string,
): ExplanationTriState {
  if (session?.running && session.runningPassageIds.includes(passageId)) return 'running'
  return groupExplanationMissing(quiz, passageId) ? 'missing' : 'ready'
}

/** mm:ss 用时展示（做题用时只在交卷当次会话里有，见 useQuizPaper.ts 头注释）。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 已作答题数：非空白 trim 后才算数（未作答的空字符串不计）。 */
export function countAnswered(questionIds: string[], answers: Record<string, string>): number {
  return questionIds.filter((id) => (answers[id] ?? '').trim() !== '').length
}
