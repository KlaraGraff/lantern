import { useMemo, useState } from 'react'
import type { WrongWordEntry } from '../types'
import { formatDateCN } from './util'
import { ConfirmModal } from './ConfirmModal'

function isTomorrow(iso: string): boolean {
  const d = new Date(iso)
  const t = new Date()
  t.setDate(t.getDate() + 1)
  return d.toDateString() === t.toDateString()
}

function statusOf(e: WrongWordEntry): { key: 'waiting' | 'due' | 'cleared'; label: string; cls: string } {
  if (e.cleared) return { key: 'cleared', label: '已出池', cls: 'ok' }
  if (e.nextDueAt && new Date(e.nextDueAt) <= new Date()) return { key: 'due', label: '今日到期', cls: 'due' }
  return { key: 'waiting', label: '等待重现', cls: 'wait' }
}

/** 屏 5：错词池 —— 复习计划表 + 清空错词池的危险操作确认 */
export function WrongWordPool(props: { entries: WrongWordEntry[]; onClearAll: () => void }) {
  const { entries, onClearAll } = props
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const activeCount = entries.filter((e) => !e.cleared).length
  const dueTomorrow = entries.filter((e) => !e.cleared && e.nextDueAt && isTomorrow(e.nextDueAt)).length

  const rows = useMemo(
    () => entries.map((e) => ({ entry: e, status: statusOf(e) })),
    [entries],
  )

  function handleExport() {
    const words = entries.filter((e) => !e.cleared).map((e) => e.word)
    if (words.length === 0) return
    navigator.clipboard?.writeText(words.join(', ')).then(
      () => {
        setToast('已复制到剪贴板')
        setTimeout(() => setToast(null), 1600)
      },
      () => {
        setToast('复制失败，请手动选取')
        setTimeout(() => setToast(null), 1600)
      },
    )
  }

  return (
    <div className="app-body">
      <div className="pool-stats">
        <div className="statlet">
          池中<b className="num">{activeCount} 词</b>
        </div>
        <div className="statlet">
          明天到期<b className="num">{dueTomorrow} 词</b>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="empty-state">还没有错词。做完试卷后，答错的词会自动进入这里排队重现。</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>单词</th>
                <th>首次答错</th>
                <th className="num">错误次数</th>
                <th>下次重现</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, status }) => (
                <tr key={entry.id}>
                  <td>
                    <span className="w en-serif">{entry.word}</span>
                  </td>
                  <td>{formatDateCN(entry.firstWrongAt)}</td>
                  <td className="num">{entry.wrongCount}</td>
                  <td className="num">{entry.nextDueAt ? formatDateCN(entry.nextDueAt) : '—'}</td>
                  <td>
                    <span className={`pill ${status.cls}`}>{status.label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pool-actions">
        <button className="btn btn-ghost" onClick={handleExport} disabled={activeCount === 0}>
          导出为词表
        </button>
        <button
          className="btn btn-ghost"
          style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}
          disabled={entries.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          清空错词池
        </button>
      </div>

      {confirmOpen && (
        <ConfirmModal
          title="清空错词池？"
          body={`将删除 ${entries.length} 个词和它们的重现计划，历史试卷里的错题记录保留。此操作不可恢复。`}
          confirmLabel={`清空 ${entries.length} 个词`}
          danger
          onConfirm={() => {
            setConfirmOpen(false)
            onClearAll()
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
