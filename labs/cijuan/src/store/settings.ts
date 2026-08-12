import { DEFAULT_SETTINGS, type AppSettings } from '../types'

const STORAGE_KEY = 'cijuan.settings'

/** 读取设置；缺失或损坏时回退默认值，与已存值浅合并以兼容将来新增字段 */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AppSettings> & { apiKey?: string; model?: string }
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS }
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      profile: { ...DEFAULT_SETTINGS.profile, ...parsed.profile },
    }
    // 旧格式迁移：多服务商改版前 key/model 存在顶层（只连 Anthropic）
    if (!parsed.profile && (parsed.apiKey || parsed.model)) {
      merged.profile = {
        provider: 'anthropic',
        baseUrl: '',
        model: parsed.model || DEFAULT_SETTINGS.profile.model,
        apiKey: parsed.apiKey || '',
      }
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}
