/**
 * 评卷页「选中文本 → 问 AI」追问抽屉的状态与行为，迁自
 * labs/cijuan/src/ui/QuizView.tsx 的追问部分，换掉的是持久化
 * （save_quiz_ask_threads 整体覆盖）与传输（transport.completeText 多轮
 * messages，而非 labs 自带 key 的 profile/callChat）。
 *
 * 入口只有一个：卷面的统一取词菜单（`useQuizLookup` + `QuizLookupLayer`）里的
 * 「问 AI」那一行，调 `openThreadFor`。这里不再自己监听 selectionchange——两套
 * 手势叠在同一段文字上会互相抢选区。
 *
 * 出处与上下文仍然读卷面上的 `data-ask-from`（人类可读出处标注）与
 * `data-ask-ctx`（发给模型的上下文全文）两个 data attribute，只是改由菜单那侧
 * 顺着 DOM 往上找、连同选中的文字一起交过来。抽屉里的消息气泡本身也打了这两个
 * 属性，所以「选中 AI 回答里的文字继续追问」和「选中原文/讲解追问」走同一条路径。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createUuid } from '../../utils/randomUuid.ts'
import { completeText, parseQuizAiProfileId } from '../../quiz/transport.ts'
import { useSettings } from '../../hooks/useSettings.ts'
import type { AskMessage, AskThread } from '../../quiz/types.ts'

/** 一次追问的全部素材：选中的文字、它的出处标注、以及要交给模型的上下文全文。 */
export interface AskTarget {
  quote: string
  quoteFrom: string
  context: string
}

/** 追问的系统提示词：把选中片段与其上下文交代清楚，答案要求简洁、中文。 */
export function buildAskSystemPrompt(opts: { quote: string; quoteFrom: string; context: string }): string {
  return `你是一名英语学习助教，正在帮一位词汇量有限的中国考生复盘一份英语试卷。考生在卷面上选中了一段文字发起追问。

## 考生选中的片段（出处：${opts.quoteFrom}）
${opts.quote}

## 片段所在的完整上下文
${opts.context}

## 回答要求
- 用中文回答，直接回应考生的问题，不要复述上下文。
- 涉及英文词汇时给出准确词义；涉及句子时先给整句翻译再解释。
- 简洁：默认三五句话说清，考生追问再展开。`
}

export interface UseAskThreadResult {
  threads: AskThread[]
  activeThread: AskThread | null
  drawerOpen: boolean
  sendingThreadId: string | null
  error: { threadId: string; message: string } | null
  selectThread: (id: string) => void
  openThreadFor: (target: AskTarget) => void
  closeDrawer: () => void
  sendMessage: (text: string) => void
  retry: () => void
}

/**
 * @param onPersist 整体覆盖式保存；线程列表每次变化后调用（除了「还没发过消息的空线程」）
 */
export function useAskThread(opts: {
  quizId: number | undefined
  initialThreads: AskThread[]
  onPersist: (threads: AskThread[]) => void
}): UseAskThreadResult {
  const { quizId, onPersist } = opts
  const { settings } = useSettings()
  // sendToApi 是空依赖数组的 useCallback（见下方定义处的说明），靠 ref 拿到最新
  // 设置值——每次渲染后同步一次，不需要因为设置变化而重建这个回调本身。
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  })

  const [threads, setThreads] = useState<AskThread[]>(opts.initialThreads)
  const threadsRef = useRef(threads)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sendingThreadId, setSendingThreadId] = useState<string | null>(null)
  const [error, setError] = useState<{ threadId: string; message: string } | null>(null)

  // 切换到另一张卷子时重新从初值取（quizId 变化即代表换卷；后续对 threads 的
  // 写入直接进 state + 落库，不应被这个效应捕获自己的写入而重置）。ref 的写入
  // 挪进一个每次渲染后都跑的效应里（不在渲染阶段直接写 ref.current）——下面
  // 那个按 quizId 才触发的效应读到的就是最新一次渲染的 initialThreads。
  const initialThreadsRef = useRef(opts.initialThreads)
  useEffect(() => {
    initialThreadsRef.current = opts.initialThreads
  })
  useEffect(() => {
    threadsRef.current = initialThreadsRef.current
    setThreads(initialThreadsRef.current)
    setActiveThreadId(null)
    setDrawerOpen(false)
    setError(null)
  }, [quizId])

  function commitThreads(next: AskThread[], persist: boolean) {
    threadsRef.current = next
    setThreads(next)
    if (persist) onPersist(next)
  }

  /**
   * 建一条新线程并开抽屉。素材由菜单那侧交过来，这里不碰选区识别。
   *
   * 副作用不塞进任何函数式 updater——StrictMode 下 updater 会被双调，建线程/开
   * 抽屉跑两遍就多出一条幽灵空线程。
   */
  const openThreadFor = useCallback((target: AskTarget) => {
    if (!target.quote.trim()) return
    const thread: AskThread = {
      id: createUuid(),
      quote: target.quote,
      quoteFrom: target.quoteFrom,
      context: target.context || target.quote,
      messages: [],
      createdAt: new Date().toISOString(),
    }
    // 空线程先不落库：一条消息没发就关掉的线程会被 closeDrawer 清理
    commitThreads([...threadsRef.current, thread], false)
    setActiveThreadId(thread.id)
    setDrawerOpen(true)
    window.getSelection()?.removeAllRanges()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    setActiveThreadId((cur) => {
      commitThreads(
        threadsRef.current.filter((t) => !(t.id === cur && t.messages.length === 0)),
        false,
      )
      return null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendToApi = useCallback(async (thread: AskThread) => {
    if (thread.messages.length === 0) return
    setSendingThreadId(thread.id)
    setError((cur) => (cur?.threadId === thread.id ? null : cur))
    try {
      const system = buildAskSystemPrompt({
        quote: thread.quote,
        quoteFrom: thread.quoteFrom,
        context: thread.context,
      })
      const reply = await completeText({
        system,
        messages: thread.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 1200,
        profileId: parseQuizAiProfileId(settingsRef.current['quiz_ai_profile_id']),
      })
      const aiMsg: AskMessage = { role: 'assistant', content: reply, at: new Date().toISOString() }
      const finalThread: AskThread = { ...thread, messages: [...thread.messages, aiMsg] }
      commitThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? finalThread : t)),
        true,
      )
    } catch (e) {
      setError({ threadId: thread.id, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSendingThreadId((cur) => (cur === thread.id ? null : cur))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const thread = threadsRef.current.find((t) => t.id === activeThreadId)
      if (!thread) return
      const userMsg: AskMessage = { role: 'user', content: trimmed, at: new Date().toISOString() }
      const withUser: AskThread = { ...thread, messages: [...thread.messages, userMsg] }
      // 用户这一轮先落库：AI 回复失败或中途离开页面，提问本身也不能丢
      commitThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? withUser : t)),
        true,
      )
      void sendToApi(withUser)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeThreadId, sendToApi],
  )

  const retry = useCallback(() => {
    if (!error) return
    const thread = threadsRef.current.find((t) => t.id === error.threadId)
    if (thread && thread.messages.length > 0) void sendToApi(thread)
    else setError(null)
  }, [error, sendToApi])

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null

  return {
    threads,
    activeThread,
    drawerOpen,
    sendingThreadId,
    error,
    selectThread: setActiveThreadId,
    openThreadFor,
    closeDrawer,
    sendMessage,
    retry,
  }
}
