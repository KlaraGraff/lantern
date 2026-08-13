/**
 * 评卷页右侧追问抽屉。宽屏固定在右侧（正文列相应收窄，交给父组件处理），
 * 窄于 900px 时改成底部弹层（样张 §E 尾注）。纯展示组件，状态与行为都在
 * useAskThread.ts；样式对照 docs/impls/cijuan-merge-mockup.html §E `.drawer`。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, MessageCircleQuestion, X } from 'lucide-react'
import { aiErrorMessageKey, getAiErrorCode } from '../../utils/aiError.ts'
import type { AskThread } from '../../quiz/types.ts'

const NARROW_QUERY = '(max-width: 900px)'

function useDrawerNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  )
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY)
    const onChange = () => setNarrow(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return narrow
}

export default function AskDrawer(props: {
  threads: AskThread[]
  activeThread: AskThread | null
  onSelectThread: (id: string) => void
  onClose: () => void
  onSend: (text: string) => void
  onRetry: () => void
  sendingThreadId: string | null
  error: { threadId: string; message: string } | null
}) {
  const { threads, activeThread, onSelectThread, onClose, onSend, onRetry, sendingThreadId, error } = props
  const { t } = useTranslation()
  const narrow = useDrawerNarrow()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const sending = activeThread != null && sendingThreadId === activeThread.id
  // 后端错误串带的是给程序看的 token（如出题模型被删时的 AI_PROFILE_NOT_AVAILABLE），
  // 注册表认得的一律换成 i18n 文案再上屏；认不出的才原样展示。
  const rawError = activeThread && error?.threadId === activeThread.id ? error.message : null
  const rawErrorCode = rawError == null ? null : getAiErrorCode(rawError)
  const activeError = rawErrorCode ? t(aiErrorMessageKey(rawErrorCode)) : rawError

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [activeThread?.messages.length, sending])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  if (!activeThread) return null

  function handleSubmit() {
    const text = input.trim()
    if (!text || sending) return
    onSend(text)
    setInput('')
  }

  return (
    <div
      className={
        narrow
          ? 'fixed inset-x-0 bottom-0 z-50 flex h-[70vh] flex-col rounded-t-xl border-t border-border bg-bg-surface shadow-context'
          : 'fixed inset-y-0 right-0 z-50 flex w-[340px] flex-col border-l border-border bg-bg-surface shadow-context'
      }
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-light px-4">
        <MessageCircleQuestion size={15} className="text-accent-text" />
        <span className="text-[13.5px] font-semibold text-text-primary">{t('quiz.paper.ask.title')}</span>
        <span className="flex-1" />
        {threads.length > 1 && (
          <select
            className="max-w-[120px] truncate rounded-md border border-border bg-bg-input px-2 py-1 text-[12px] text-text-secondary"
            value={activeThread.id}
            onChange={(e) => onSelectThread(e.target.value)}
          >
            {threads.map((th) => (
              <option key={th.id} value={th.id}>
                {th.quote.length > 16 ? `${th.quote.slice(0, 16)}…` : th.quote}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-label={t('quiz.paper.ask.close')}
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"
        >
          <X size={15} />
        </button>
      </div>

      <div className="shrink-0 border-b border-border-light px-4 py-3">
        <p className="font-serif text-[13px] leading-[1.6] text-text-primary">{activeThread.quote}</p>
        <p className="mt-1 text-[11.5px] text-text-muted">
          {t('quiz.paper.ask.quoteFrom', { from: activeThread.quoteFrom })}
        </p>
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {activeThread.messages.length === 0 && (
          <div className="text-[12.5px] leading-[1.7] text-text-muted">{t('quiz.paper.ask.empty')}</div>
        )}
        {activeThread.messages.map((m, i) => (
          <div
            key={i}
            data-ask-from={t('quiz.paper.ask.messageFrom', {
              role: m.role === 'user' ? t('quiz.paper.ask.roleUser') : t('quiz.paper.ask.roleAi'),
            })}
            data-ask-ctx={m.content}
            className={
              m.role === 'user'
                ? 'ml-auto max-w-[85%] rounded-lg rounded-tr-sm bg-accent px-3 py-2 text-[13px] leading-[1.6] text-white'
                : 'mr-auto max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tl-sm bg-bg-input px-3 py-2 text-[13px] leading-[1.6] text-text-primary'
            }
          >
            {m.content}
          </div>
        ))}
        {sending && (
          <div className="mr-auto max-w-[85%] rounded-lg rounded-tl-sm bg-bg-input px-3 py-2 text-[13px] text-text-muted">
            {t('quiz.paper.ask.thinking')}
          </div>
        )}
      </div>

      {activeError && (
        <div className="shrink-0 border-t border-danger-border bg-danger-bg px-4 py-2.5 text-[12px] text-danger-text">
          <p>{activeError}</p>
          <button type="button" onClick={onRetry} className="mt-1 font-medium underline">
            {t('quiz.paper.ask.retry')}
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-border-light p-3">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            placeholder={t('quiz.paper.ask.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            className="max-h-24 min-h-9 flex-1 resize-none rounded-lg border border-border bg-bg-input px-3 py-2 text-[13px] text-text-primary placeholder:text-text-placeholder focus:outline-none"
          />
          <button
            type="button"
            aria-label={t('quiz.paper.ask.send')}
            disabled={sending || !input.trim()}
            onClick={handleSubmit}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors disabled:opacity-40"
          >
            <ArrowUp size={16} />
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-[1.6] text-text-muted">{t('quiz.paper.ask.hint')}</p>
      </div>
    </div>
  )
}
