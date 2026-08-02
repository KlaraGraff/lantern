/**
 * The built-in model catalog.
 *
 * A preset is only what Lantern knows about a provider up front — endpoint,
 * default model, how it bills, where the user creates a key. It carries no
 * credentials: the user always brings their own key, and Lantern never ships a
 * shared one.
 *
 * Cost is deliberately not part of the display name. A profile's name is copied
 * into the user's own configuration when they add it and later updates may not
 * rewrite it, so a name promising "free" could neither be corrected nor kept
 * honest if the provider changed its terms. Pricing lives in a chip instead,
 * which is presentation and can change with the app.
 *
 * Adding a preset here does not touch anyone's existing route. It only changes
 * what the catalog offers.
 */

/** How a provider bills. Drives the chip beside the model name. */
export type CostTier = "free" | "local" | "metered";

export interface AiPreset {
  /** Matches the `provider` column, and the Rust dispatch in `ai/router.rs`. */
  provider: string;
  /** `null` means the backend's own default for this provider. */
  baseUrl: string | null;
  model: string;
  /** Ollama-only; every hosted provider leaves this unset. */
  keepAlive: string | null;
  /** `null` when the cost is unknowable from here, as with a custom endpoint. */
  cost: CostTier | null;
  /** Official key page, opened in the system browser. `null` disables the button. */
  keyPage: string | null;
  /** i18n key for the provider's display name. */
  nameKey: string;
  /** i18n key for the one-line blurb in the catalog. */
  descriptionKey: string;
  /** i18n key for the "get a key" button, when the default wording is too plain. */
  keyButtonKey?: string;
}

/** Zhipu's mainland endpoint. Already carries its `/v4` version segment. */
export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZHIPU_DEFAULT_MODEL = "glm-4.7-flash";

/** DeepSeek publishes no version segment; the backend appends `/v1`. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Catalog order, which is also the order of the provider dropdown. The free
 * model a first-time user can actually sign up for comes first; `custom` is
 * last because it is the escape hatch, not a recommendation.
 *
 * Endpoints and model IDs verified against the providers' own docs on
 * 2026-08-02. A provider can change these at any time; when that happens,
 * update the catalog — never silently rewrite a route the user already saved.
 */
export const AI_PRESETS: AiPreset[] = [
  {
    provider: "zhipu",
    baseUrl: ZHIPU_BASE_URL,
    model: ZHIPU_DEFAULT_MODEL,
    keepAlive: null,
    cost: "free",
    keyPage: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    nameKey: "settings.ai.presetName.zhipu",
    descriptionKey: "settings.ai.presetDesc.zhipu",
    keyButtonKey: "settings.ai.connectGetKeyFree",
  },
  {
    provider: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    keepAlive: null,
    cost: "metered",
    keyPage: "https://platform.deepseek.com/api_keys",
    nameKey: "settings.ai.presetName.deepseek",
    descriptionKey: "settings.ai.presetDesc.deepseek",
  },
  {
    provider: "openai",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o-mini",
    keepAlive: null,
    cost: "metered",
    keyPage: "https://platform.openai.com/api-keys",
    nameKey: "settings.ai.presetName.openai",
    descriptionKey: "settings.ai.presetDesc.openai",
  },
  {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    keepAlive: null,
    cost: "metered",
    keyPage: "https://console.anthropic.com/settings/keys",
    nameKey: "settings.ai.presetName.anthropic",
    descriptionKey: "settings.ai.presetDesc.anthropic",
  },
  {
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen3.5",
    keepAlive: "30m",
    cost: "local",
    keyPage: null,
    nameKey: "settings.ai.presetName.ollama",
    descriptionKey: "settings.ai.presetDesc.ollama",
  },
  {
    provider: "custom",
    baseUrl: "",
    model: "",
    keepAlive: null,
    cost: null,
    keyPage: null,
    nameKey: "settings.ai.customCompatible",
    descriptionKey: "settings.ai.presetDesc.custom",
  },
];

/** Chip styling per cost tier. Lives here so the catalog and the route agree. */
export const COST_TIER_CLASSES: Record<CostTier, string> = {
  free: "bg-success/10 text-success-text",
  local: "bg-bg-input text-text-secondary",
  metered: "bg-accent-bg text-accent-text",
};

export function presetFor(provider: string): AiPreset | undefined {
  return AI_PRESETS.find((preset) => preset.provider === provider);
}
