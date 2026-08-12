import { useEffect, useRef, useState } from 'react'
import type { AskThread } from '../types'

/**
 * 评卷页右侧追问抽屉（窄屏经 CSS 改成底部弹层，见 index.css .ask-drawer 的媒体查询）。
 * 只做单卷内的轻量线程列表，不做跨卷索引——将来并入 Lantern 时这层会被替换。
 */
export function AskDrawer(props: {
  threads: AskThread[]
  activeThreadId: string | null
  onSelectThread: (id: string) => void
  onClose: () => void
  onSend: (text: string) => void
  onRetry: () => void
  /** 正在等 AI 回复的线程 id：只有看着它时才显示加载态，切去别的线程不跟随 */
  sendingThreadId: string | null
  error: { threadId: string; message: string } | null
  /** 演示卷或未配置 key：不联网，输入框禁用 */
  disabled: boolean
}) {
  const { threads, activeThreadId, onSelectThread, onClose, onSend, onRetry, sendingThreadId, error, disabled } = props
  const [input, setInput] = useState('')
  const active = threads.find((t) => t.id === activeThreadId) ?? threads[threads.length - 1] ?? null
  const sending = active != null && sendingThreadId === active.id
  const activeError = active && error?.threadId === active.id ? error.message : null
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [active?.messages.length, sending])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!active) return null

  function handleSubmit() {
    const text = input.trim()
    if (!text || sending || disabled) return
    onSend(text)
    setInput('')
  }

  return (
    <div className="ask-drawer">
      <h4>
        ✦ 追问
        <span style={{ flex: 1 }} />
        {threads.length > 1 && (
          <select className="thread-switch" value={active.id} onChange={(e) => onSelectThread(e.target.value)}>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.quote.length > 16 ? `${t.quote.slice(0, 16)}…` : t.quote}
              </option>
            ))}
          </select>
        )}
        <button className="close" aria-label="关闭追问抽屉" onClick={onClose}>
          ✕
        </button>
      </h4>
      <div className="quote-chip">
        <span className="en-serif">{active.quote}</span>
        <span className="from">引自 {active.quoteFrom} —— 追问自动带上本题与原文上下文</span>
      </div>
      <div className="ask-msgs" ref={listRef}>
        {active.messages.length === 0 && !disabled && (
          <div className="ask-empty">对这段内容有疑问？在下面输入你的问题。</div>
        )}
        {active.messages.map((m, i) => (
          <div
            key={i}
            className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}
            data-ask-from={`追问 · ${m.role === 'user' ? '我的提问' : 'AI 回答'}`}
            data-ask-ctx={m.content}
          >
            {m.content}
          </div>
        ))}
        {sending && <div className="msg ai pending">思考中…</div>}
      </div>
      {activeError && (
        <div className="ask-error">
          <span>{activeError}</span>
          <button onClick={onRetry}>重试</button>
        </div>
      )}
      {disabled && <div className="hint">演示卷不联网，配置 API key 后可用</div>}
      <div className="composer">
        <input
          placeholder="继续追问，或选中文字后提问…"
          value={input}
          disabled={disabled || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        <button onClick={handleSubmit} disabled={disabled || sending || !input.trim()}>
          发送
        </button>
      </div>
      {!disabled && <div className="hint">追问记录随试卷保存。选中讲解或 AI 回答里的文字可以继续追问。</div>}
    </div>
  )
}
