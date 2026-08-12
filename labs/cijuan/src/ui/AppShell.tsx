import type { ReactNode } from 'react'

export type NavTarget = 'setup' | 'pool' | 'history'

/** 顶部导航栏：出题 / 错词池 / 历史卷，右侧放 key 状态 + 设置齿轮，五屏通用外壳 */
export function AppShell(props: {
  active: NavTarget | null
  onNavigate: (target: NavTarget) => void
  keyReady: boolean
  keyLabel: string
  onOpenSettings: () => void
  right?: ReactNode
}) {
  const { active, onNavigate, keyReady, keyLabel, onOpenSettings, right } = props
  return (
    <div className="appbar">
      <button className="brand logotype" onClick={() => onNavigate('setup')}>
        词卷
      </button>
      <nav>
        <button className={active === 'setup' ? 'on' : ''} onClick={() => onNavigate('setup')}>
          出题
        </button>
        <button className={active === 'pool' ? 'on' : ''} onClick={() => onNavigate('pool')}>
          错词池
        </button>
        <button className={active === 'history' ? 'on' : ''} onClick={() => onNavigate('history')}>
          历史卷
        </button>
      </nav>
      <span className="spacer" />
      {right}
      <span className={`key-state ${keyReady ? '' : 'off'}`}>
        <i />
        {keyLabel}
      </span>
      <button className="gear" onClick={onOpenSettings} aria-label="设置" title="设置">
        ⚙
      </button>
    </div>
  )
}
