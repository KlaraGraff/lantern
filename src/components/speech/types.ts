export type SpeechAccent = "uk" | "us";
export type SpeechSourceId = "auto" | "dictionary" | "system" | "edge" | "custom";
export type SpeechKind = "word" | "phrase" | "passage";
export type SpeechStatus = "idle" | "loading" | "playing" | "paused" | "error";

export const SPEECH_SOURCE_SETTING_KEY = "speech_source";
export const SPEECH_ACCENT_SETTING_KEY = "speech_accent";
export const SPEECH_RATE_SETTING_KEY = "speech_rate";
export const SPEECH_CUSTOM_BASE_URL_KEY = "tts_base_url";
export const SPEECH_CUSTOM_MODEL_KEY = "tts_model";
export const SPEECH_CUSTOM_VOICE_UK_KEY = "tts_voice_uk";
export const SPEECH_CUSTOM_VOICE_US_KEY = "tts_voice_us";
export const SPEECH_CUSTOM_SPEED_KEY = "tts_speed";
export const SPEECH_CUSTOM_CACHE_PASSAGES_KEY = "tts_cache_passages";

export const SPEECH_SETTING_KEYS = [
  SPEECH_SOURCE_SETTING_KEY,
  SPEECH_ACCENT_SETTING_KEY,
  SPEECH_RATE_SETTING_KEY,
  SPEECH_CUSTOM_BASE_URL_KEY,
  SPEECH_CUSTOM_MODEL_KEY,
  SPEECH_CUSTOM_VOICE_UK_KEY,
  SPEECH_CUSTOM_VOICE_US_KEY,
  SPEECH_CUSTOM_SPEED_KEY,
  SPEECH_CUSTOM_CACHE_PASSAGES_KEY,
] as const;

/** Provider settings for the OpenAI-compatible source. The key is never here. */
export interface CustomSpeechConfig {
  baseUrl: string;
  model: string;
  voiceUk: string;
  voiceUs: string;
  /** Sent to the provider, which bakes it into the audio it returns. */
  speed: number;
  /**
   * Whether passage-length audio from this provider is kept on disk. Defaults to
   * on: disk has a ceiling, eviction and a clear button, while re-synthesizing a
   * passage bills the user a second time for text they already paid for.
   */
  cachePassages: boolean;
}

export interface SpeechSettings {
  source: SpeechSourceId;
  accent: SpeechAccent;
  rate: number;
  custom: CustomSpeechConfig;
}

/**
 * Automatic is the default because no single source is right for everything: a
 * word wants the dictionary's human recording, a passage wants a synthesizer the
 * dictionary has no audio for, and every failure wants system voices. Making the
 * user pick one up front means picking wrong for half of what they play.
 */
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  source: "auto",
  accent: "us",
  rate: 1,
  custom: {
    baseUrl: "",
    model: "",
    voiceUk: "",
    voiceUs: "",
    speed: 1,
    cachePassages: true,
  },
};

/**
 * The rate the local synthesizer is driven at. The floor is 0.5 because 0 is
 * not a speed — it is silence — and the ceiling matches the fastest preset.
 */
export const SPEECH_RATE_RANGE = { min: 0.5, max: 2, step: 0.05 } as const;
/** What OpenAI-compatible speech endpoints accept for `speed`. */
export const SPEECH_CUSTOM_SPEED_RANGE = { min: 0.25, max: 4 } as const;
/** Playback speeds worth one tap, in the order a media player lists them. */
export const SPEECH_RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function clampCustomSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEECH_SETTINGS.custom.speed;
  return Math.min(SPEECH_CUSTOM_SPEED_RANGE.max, Math.max(SPEECH_CUSTOM_SPEED_RANGE.min, value));
}

const SPEECH_SOURCE_IDS: readonly SpeechSourceId[] = [
  "auto",
  "dictionary",
  "system",
  "edge",
  "custom",
];

function parseSource(value: string | undefined): SpeechSourceId {
  return SPEECH_SOURCE_IDS.find((id) => id === value) ?? DEFAULT_SPEECH_SETTINGS.source;
}

export function parseSpeechSettings(values: Record<string, string | undefined>): SpeechSettings {
  const source = values[SPEECH_SOURCE_SETTING_KEY];
  const accent = values[SPEECH_ACCENT_SETTING_KEY];
  const rate = Number.parseFloat(values[SPEECH_RATE_SETTING_KEY] ?? "");
  const text = (key: string) => (values[key] ?? "").trim();

  return {
    source: parseSource(source),
    accent: accent === "uk" || accent === "us" ? accent : DEFAULT_SPEECH_SETTINGS.accent,
    rate: Number.isFinite(rate)
      ? Math.min(SPEECH_RATE_RANGE.max, Math.max(SPEECH_RATE_RANGE.min, rate))
      : DEFAULT_SPEECH_SETTINGS.rate,
    custom: {
      baseUrl: text(SPEECH_CUSTOM_BASE_URL_KEY),
      model: text(SPEECH_CUSTOM_MODEL_KEY),
      voiceUk: text(SPEECH_CUSTOM_VOICE_UK_KEY),
      voiceUs: text(SPEECH_CUSTOM_VOICE_US_KEY),
      speed: clampCustomSpeed(Number.parseFloat(values[SPEECH_CUSTOM_SPEED_KEY] ?? "")),
      // Only an explicit "false" turns it off, so an unset key keeps the safe
      // default rather than reading as disabled.
      cachePassages: values[SPEECH_CUSTOM_CACHE_PASSAGES_KEY] !== "false",
    },
  };
}

export type SpeechFailureReason =
  /** Nothing on this machine can speak — no synthesizer, no voices. */
  | "unsupported"
  /** Every source in the chain was tried and failed. */
  | "unavailable";

export class SpeechError extends Error {
  // Declared as a field rather than a constructor parameter property, which
  // Node's type stripping cannot parse when the unit tests import this module.
  readonly reason: SpeechFailureReason;

  constructor(reason: SpeechFailureReason) {
    super(reason);
    this.name = "SpeechError";
    this.reason = reason;
  }
}
