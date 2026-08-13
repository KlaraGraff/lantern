/**
 * 评卷页「选中文本 → 问 AI」追问抽屉的状态与行为，迁自
 * labs/cijuan/src/ui/QuizView.tsx 的追问部分（selectionchange 监听 + 线程列表），
 * 换掉的是持久化（save_quiz_ask_threads 整体覆盖）与传输（transport.completeText
 * 多轮 messages，而非 labs 自带 key 的 profile/callChat）。
 *
 * 选区识别：卷面上任何想被追问的区域打 `data-ask-from`（人类可读出处标注）与
 * `data-ask-ctx`（发给模型的上下文全文）两个 data attribute，选中其中的文字会
 * 浮出「问 AI」气泡；不在这类区域内的选区不触发。抽屉里的消息气泡本身也打了
 * 这两个属性，所以「选中 AI 回答里的文字继续追问」和「选中原文/讲解追问」走
 * 同一条路径。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createUuid } from '../../utils/randomUuid.ts'
import { completeText } from '../../quiz/transport.ts'
import type { AskMessage, AskThread } from '../../quiz/types.ts'

export interface AskPop {
  quote: string
  quoteFrom: string
  context: string
  x: number
  y: number
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
  askPop: AskPop | null
  drawerOpen: boolean
  sendingThreadId: string | null
  error: { threadId: string; message: string } | null
  selectThread: (id: string) => void
  openThread: () => void
  closeDrawer: () => void
  sendMessage: (text: string) => void
  retry: () => void
}

/**
 * @param enabled 只在评卷模式下监听选区（做题态不该弹「问 AI」）
 * @param onPersist 整体覆盖式保存；线程列表每次变化后调用（除了「还没发过消息的空线程」）
 */
export function useAskThread(opts: {
  quizId: number | undefined
  initialThreads: AskThread[]
  enabled: boolean
  onPersist: (threads: AskThread[]) => void
}): UseAskThreadResult {
  const { quizId, enabled, onPersist } = opts

  const [threads, setThreads] = useState<AskThread[]>(opts.initialThreads)
  const threadsRef = useRef(threads)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [askPop, setAskPop] = useState<AskPop | null>(null)
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
    setAskPop(null)
    setError(null)
  }, [quizId])

  function commitThreads(next: AskThread[], persist: boolean) {
    threadsRef.current = next
    setThreads(next)
    if (persist) onPersist(next)
  }

  useEffect(() => {
    if (!enabled) return
    function onSelectionChange() {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setAskPop(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setAskPop(null)
        return
      }
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement
      const from = el?.closest<HTMLElement>('[data-ask-from]')
      if (!from) {
        setAskPop(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setAskPop(null)
        return
      }
      setAskPop({
        quote: text,
        quoteFrom: from.dataset.askFrom ?? '',
        context: from.dataset.askCtx ?? text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [enabled])

  // 副作用不能塞进 setAskPop 的函数式 updater——StrictMode 下 updater 会被双调，
  // 建线程/开抽屉跑两遍就多出一条幽灵空线程。这里直接读 state、末尾清 pop。
  const openThread = useCallback(() => {
    if (!askPop) return
    const thread: AskThread = {
      id: createUuid(),
      quote: askPop.quote,
      quoteFrom: askPop.quoteFrom,
      context: askPop.context,
      messages: [],
      createdAt: new Date().toISOString(),
    }
    // 空线程先不落库：一条消息没发就关掉的线程会被 closeDrawer 清理
    commitThreads([...threadsRef.current, thread], false)
    setActiveThreadId(thread.id)
    setDrawerOpen(true)
    window.getSelection()?.removeAllRanges()
    setAskPop(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askPop])

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
    askPop,
    drawerOpen,
    sendingThreadId,
    error,
    selectThread: setActiveThreadId,
    openThread,
    closeDrawer,
    sendMessage,
    retry,
  }
}
