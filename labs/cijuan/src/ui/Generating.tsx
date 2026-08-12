import type { GenerateStep } from '../llm'
import type { QuizConfig } from '../types'

interface StepDef {
  key: GenerateStep
  label: string
  note?: string
}

function buildSteps(config: QuizConfig, wordCount: number, passageCount: number): StepDef[] {
  const steps: StepDef[] = [
    { key: 'splitting', label: `解析 ${wordCount} 个词，分为 ${passageCount} 篇` },
    { key: 'writing', label: '生成文章与题目' },
  ]
  if (config.maskedCheck) {
    steps.push({
      key: 'maskedCheck',
      label: '考点自检中',
      note: '遮住目标词重做题，验证「不认识就做不出」，不合格的题重出',
    })
    steps.push({ key: 'regenerating', label: '重出未通过自检的题' })
  }
  return steps
}

/** 屏 2：生成中 —— 四步加载态；出错时替换成错误卡片，可返回或重试 */
export function Generating(props: {
  step: GenerateStep
  config: QuizConfig
  wordCount: number
  passageCount: number
  error: string | null
  onRetry: () => void
  onBack: () => void
}) {
  const { step, config, wordCount, passageCount, error, onRetry, onBack } = props

  if (error) {
    return (
      <div className="app-body" style={{ padding: '56px 32px 64px' }}>
        <div className="steps">
          <div className="banner error">
            <span className="tag">出错</span>
            <span>{error}</span>
          </div>
          <div className="cta-row" style={{ borderTop: 0, justifyContent: 'center' }}>
            <button className="btn btn-ghost" onClick={onBack}>
              返回修改
            </button>
            <button className="btn btn-primary" onClick={onRetry}>
              重试
            </button>
          </div>
        </div>
      </div>
    )
  }

  const steps = buildSteps(config, wordCount, passageCount)
  const order: GenerateStep[] = ['splitting', 'writing', 'maskedCheck', 'regenerating', 'done']
  const currentIndex = order.indexOf(step)
  const progressPct = Math.min(100, Math.round(((currentIndex + 1) / (steps.length + 1)) * 100))

  return (
    <div className="app-body" style={{ padding: '56px 32px 64px' }}>
      <div className="steps">
        {steps.map((s) => {
          const idx = order.indexOf(s.key)
          const status = idx < currentIndex ? 'done' : idx === currentIndex ? 'doing' : 'todo'
          const mark = status === 'done' ? '✓' : status === 'doing' ? '…' : '○'
          return (
            <div className={`step ${status}`} key={s.key}>
              <span className="mark">{mark}</span>
              <span>
                {s.label}
                {s.note && status !== 'todo' && <span className="note">{s.note}</span>}
              </span>
            </div>
          )
        })}
      </div>
      <div className="progress">
        <i style={{ width: `${progressPct}%` }} />
      </div>
      <div className="center-note">约还需 40 秒 · 请勿关闭页面</div>
    </div>
  )
}
