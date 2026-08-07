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
  /**
   * The provider's own billing/usage page. The auto-analysis console links
   * here for anything involving money, because it never converts tokens into
   * currency itself. `null` for a provider that bills nothing (a local model)
   * or whose page we cannot know (a custom endpoint) — the console then shows
   * no link rather than a guess.
   */
  usagePage: string | null;
  /** i18n key for the provider's display name. */
  nameKey: string;
  /** i18n key for the one-line blurb in the catalog. */
  descriptionKey: string;
  /** i18n key for the "get a key" button, when the default wording is too plain. */
  keyButtonKey?: string;
}

/** DeepSeek publishes no version segment; the backend appends `/v1`. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Catalog order, which is also the order of the provider dropdown. DeepSeek
 * comes first: it is the cheapest endpoint here that still answers grammar and
 * word-sense questions correctly, and it takes a key without an overseas card.
 * `custom` is last because it is the escape hatch, not a recommendation.
 *
 * There is deliberately no free preset. The one we shipped a free tier against
 * was small enough to produce confident, wrong explanations, which is worse for
 * a reader learning the language than having to add a key. A free model can
 * come back here once one passes on quality, not on price.
 *
 * Endpoints and model IDs verified against the providers' own docs on
 * 2026-08-02. A provider can change these at any time; when that happens,
 * update the catalog — never silently rewrite a route the user already saved.
 */
export const AI_PRESETS: AiPreset[] = [
  {
    provider: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    keepAlive: null,
    cost: "metered",
    keyPage: "https://platform.deepseek.com/api_keys",
    usagePage: "https://platform.deepseek.com/usage",
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
    usagePage: "https://platform.openai.com/usage",
    nameKey: "settings.ai.presetName.openai",
    descriptionKey: "settings.ai.presetDesc.openai",
  },
  {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    keepAlive: null,
    cost: "metered",
    keyPage: "https://console.anthropic.com/settings/keys",
    usagePage: "https://console.anthropic.com/settings/usage",
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
    usagePage: null,
    nameKey: "settings.ai.presetName.ollama",
    descriptionKey: "settings.ai.presetDesc.ollama",
  },
  {
    provider: "lmstudio",
    baseUrl: "http://localhost:1234",
    model: "",
    // LM Studio has its own idle-unload TTL in its Developer settings; unlike
    // Ollama it does not read a `keep_alive` request field, so this preset
    // never sets one.
    keepAlive: null,
    cost: "local",
    keyPage: null,
    usagePage: null,
    nameKey: "settings.ai.presetName.lmstudio",
    descriptionKey: "settings.ai.presetDesc.lmstudio",
  },
  {
    provider: "custom",
    baseUrl: "",
    model: "",
    keepAlive: null,
    cost: null,
    keyPage: null,
    usagePage: null,
    nameKey: "settings.ai.customCompatible",
    descriptionKey: "settings.ai.presetDesc.custom",
  },
];

/**
 * The catalog as this platform may offer it.
 *
 * Ollama and LM Studio are model servers the reader runs beside Lantern, reached
 * at `localhost:11434` and `localhost:1234` respectively; a phone has neither,
 * so offering either there would only produce a route that can never answer.
 * Every other preset is an ordinary HTTPS endpoint and travels everywhere —
 * including a study-room Mac's Ollama or LM Studio, which is reached through
 * `custom` with a LAN address.
 *
 * Takes the capability rather than reading `platform` itself so the rule is
 * testable without a webview, and so the call site stays the place that says
 * which capability it is asking about.
 *
 * `keep` re-admits a provider a saved profile already uses. A model configured
 * on a Mac syncs its provider name to the phone, and dropping it from the
 * dropdown there would leave that profile showing a blank provider — the data
 * exists whether or not this platform would offer it today.
 */
export function availablePresets(hasLocalModelRuntime: boolean, keep?: string): AiPreset[] {
  return AI_PRESETS.filter((preset) => (
    !isLocalModelServerProvider(preset.provider) || hasLocalModelRuntime || preset.provider === keep
  ));
}

/** Chip styling per cost tier. Lives here so the catalog and the route agree. */
export const COST_TIER_CLASSES: Record<CostTier, string> = {
  free: "bg-success/10 text-success-text",
  local: "bg-bg-input text-text-secondary",
  metered: "bg-accent-bg text-accent-text",
};

export function presetFor(provider: string): AiPreset | undefined {
  return AI_PRESETS.find((preset) => preset.provider === provider);
}

/**
 * Ollama and LM Studio both run beside Lantern, answer with no credential at
 * all, and are unreachable from anywhere but this machine. Every call site
 * that means "does this provider need a key" or "is this a local model
 * server" belongs on this predicate, so a second local provider is never
 * added twice. Mirrors `is_keyless_local_provider` in `ai/router.rs` — keep
 * the two lists in sync.
 */
export function isLocalModelServerProvider(provider: string): boolean {
  return provider === "ollama" || provider === "lmstudio";
}
