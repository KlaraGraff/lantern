import { useState } from 'react'
import type { AiProfile, AppSettings, ProviderId } from '../types'
import { AI_PRESETS, isLocalProvider, presetFor } from '../llm'

/** 设置弹窗：服务商 + 端点 + 模型 + key、遮词自检开关、演示模式开关 */
export function SettingsModal(props: {
  settings: AppSettings
  onSave: (next: AppSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AppSettings>(props.settings)
  const preset = presetFor(draft.profile.provider)
  const local = isLocalProvider(draft.profile.provider)

  function updateProfile(patch: Partial<AiProfile>) {
    setDraft((d) => ({ ...d, profile: { ...d.profile, ...patch } }))
  }

  function handleProviderChange(provider: ProviderId) {
    const next = presetFor(provider)
    // 切服务商：端点清空（placeholder 展示新默认值）、模型预填新服务商默认模型
    updateProfile({ provider, baseUrl: '', model: next.defaultModel })
  }

  return (
    <div className="veil" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h4>设置</h4>
        <p>API key 只存在本机浏览器（localStorage），不会上传到任何服务器。</p>

        <div className="field">
          <label htmlFor="provider">AI 服务商</label>
          <select
            id="provider"
            value={draft.profile.provider}
            onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
          >
            {AI_PRESETS.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="sub">{preset.description}</span>
        </div>

        <div className="field">
          <label htmlFor="baseurl">
            API 端点 {draft.profile.provider === 'custom' && <span style={{ color: 'var(--bad)' }}>· 必填</span>}
          </label>
          <input
            id="baseurl"
            type="text"
            placeholder={preset.baseUrl || '必填：OpenAI 兼容端点，如 https://your-gateway.com'}
            value={draft.profile.baseUrl}
            onChange={(e) => updateProfile({ baseUrl: e.target.value })}
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="model">出题模型</label>
          <input
            id="model"
            type="text"
            placeholder={preset.defaultModel || '模型 ID'}
            value={draft.profile.model}
            onChange={(e) => updateProfile({ model: e.target.value })}
            autoComplete="off"
          />
        </div>

        {!local && (
          <div className="field">
            <label htmlFor="apikey">
              API key
              {preset.keyPage && (
                <a href={preset.keyPage} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                  获取 API key ↗
                </a>
              )}
            </label>
            <input
              id="apikey"
              type="password"
              placeholder="粘贴 API key"
              value={draft.profile.apiKey}
              onChange={(e) => updateProfile({ apiKey: e.target.value })}
              autoComplete="off"
            />
          </div>
        )}

        <div className="switch-row">
          <span>
            遮词自检
            <span className="sub">生成后多一轮检验，考点更准，多花约半分钟</span>
          </span>
          <button
            className={`switch ${draft.maskedCheck ? '' : 'off'}`}
            aria-pressed={draft.maskedCheck}
            aria-label="遮词自检"
            onClick={() => setDraft({ ...draft, maskedCheck: !draft.maskedCheck })}
          />
        </div>

        <div className="switch-row">
          <span>
            演示模式
            <span className="sub">不消耗 API 额度，用内置样卷体验完整流程</span>
          </span>
          <button
            className={`switch ${draft.demoMode ? '' : 'off'}`}
            aria-pressed={draft.demoMode}
            aria-label="演示模式"
            onClick={() => setDraft({ ...draft, demoMode: !draft.demoMode })}
          />
        </div>

        <div className="row">
          <button className="btn btn-ghost" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => props.onSave(draft)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
