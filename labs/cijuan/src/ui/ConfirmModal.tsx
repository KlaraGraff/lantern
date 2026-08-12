/** 通用确认弹窗：危险操作（清空错词池）与普通确认（未答题交卷）共用同一套样式 */
export function ConfirmModal(props: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { title, body, confirmLabel, cancelLabel = '取消', danger, onConfirm, onCancel } = props
  return (
    <div className="veil" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h4>{title}</h4>
        <p>{body}</p>
        <div className="row">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
