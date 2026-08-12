import type { AiProfile, ProviderId } from '../types'

/**
 * AI 服务商目录，模式照搬本机 Lantern 项目的 aiPresets.ts：
 * 预设只记录「产品预先知道的事」——端点、默认模型、去哪领 key；
 * 永远不带凭据，key 一律用户自备。
 *
 * Anthropic 排第一（本产品默认，Opus 5 出题质量最好）；
 * custom 排最后，它是逃生口不是推荐项。
 */

/** 计费方式，驱动 UI 上模型名旁边的小标签 */
export type CostTier = 'local' | 'metered'

export interface AiPreset {
  provider: ProviderId
  name: string
  /** 服务商默认端点；custom 为空必须用户自填 */
  baseUrl: string
  defaultModel: string
  cost: CostTier | null
  /** 官方领 key 页面；本地服务商为 null */
  keyPage: string | null
  /** 服务商自己的用量/账单页；估不出费用时 UI 引导去这里看 */
  usagePage: string | null
  description: string
}

/** 端点与模型 ID 于 2026-08 按各服务商文档核对；服务商随时可能改，改了就更新目录 */
export const AI_PRESETS: AiPreset[] = [
  {
    provider: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5',
    cost: 'metered',
    keyPage: 'https://console.anthropic.com/settings/keys',
    usagePage: 'https://console.anthropic.com/settings/usage',
    description: '默认线路，Opus 5 出题质量最好；可换 Sonnet / Haiku 降费用',
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    cost: 'metered',
    keyPage: 'https://platform.deepseek.com/api_keys',
    usagePage: 'https://platform.deepseek.com/usage',
    description: '便宜，国内可直接付款开 key',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    cost: 'metered',
    keyPage: 'https://platform.openai.com/api-keys',
    usagePage: 'https://platform.openai.com/usage',
    description: 'OpenAI 官方接口',
  },
  {
    provider: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen3.5',
    cost: 'local',
    keyPage: null,
    usagePage: null,
    description: '本机模型服务，免费无需 key；需先安装 Ollama 并拉取模型',
  },
  {
    provider: 'lmstudio',
    name: 'LM Studio（本机）',
    baseUrl: 'http://localhost:1234',
    defaultModel: '',
    cost: 'local',
    keyPage: null,
    usagePage: null,
    description: '本机模型服务，免费无需 key；模型名以 LM Studio 里加载的为准',
  },
  {
    provider: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    cost: null,
    keyPage: null,
    usagePage: null,
    description: '任何 OpenAI 兼容端点（中转、网关、局域网服务）',
  },
]

export function presetFor(provider: ProviderId): AiPreset {
  return AI_PRESETS.find((p) => p.provider === provider) ?? AI_PRESETS[AI_PRESETS.length - 1]
}

/** 本地模型服务：不需要 key、只有本机可达。判定统一走这里，别在调用处散写 */
export function isLocalProvider(provider: ProviderId): boolean {
  return provider === 'ollama' || provider === 'lmstudio'
}

/** 该线路是否已配置到能发请求的程度 */
export function profileReady(p: AiProfile): boolean {
  const base = p.baseUrl.trim() || presetFor(p.provider).baseUrl
  if (!base || !p.model.trim()) return false
  return isLocalProvider(p.provider) || p.provider === 'custom'
    ? true // 本地免 key；custom 的 key 是否必需由端点自己决定
    : p.apiKey.trim().length > 0
}

/**
 * OpenAI 兼容端点拼接（规则照搬 Lantern 的 compat_endpoint）：
 * base 的路径末段已经是版本号（v1 / v4 / …）就直接拼 path，
 * 否则补 /v1——避免把 https://host/api/paas/v4 拼成 …/v4/v1/chat/completions。
 */
export function compatEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return endsWithVersionSegment(base) ? `${base}/${path}` : `${base}/v1/${path}`
}

function endsWithVersionSegment(base: string): boolean {
  // 只看路径：v4.example.com 这种主机名不算版本号
  const afterScheme = base.includes('://') ? base.split('://')[1] : base
  const slash = afterScheme.indexOf('/')
  if (slash === -1) return false
  const lastSegment = afterScheme.slice(slash + 1).split('/').pop() ?? ''
  return /^v\d+$/.test(lastSegment)
}
