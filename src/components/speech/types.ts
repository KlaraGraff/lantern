export type SpeechAccent = "uk" | "us";
export type SpeechSourceId = "dictionary" | "system" | "custom";
export type SpeechKind = "word" | "phrase" | "passage";
export type SpeechStatus = "idle" | "loading" | "playing" | "error";

export const SPEECH_SOURCE_SETTING_KEY = "speech_source";
export const SPEECH_ACCENT_SETTING_KEY = "speech_accent";
export const SPEECH_RATE_SETTING_KEY = "speech_rate";
export const SPEECH_CUSTOM_BASE_URL_KEY = "tts_base_url";
export const SPEECH_CUSTOM_MODEL_KEY = "tts_model";
export const SPEECH_CUSTOM_VOICE_UK_KEY = "tts_voice_uk";
export const SPEECH_CUSTOM_VOICE_US_KEY = "tts_voice_us";

export const SPEECH_SETTING_KEYS = [
  SPEECH_SOURCE_SETTING_KEY,
  SPEECH_ACCENT_SETTING_KEY,
  SPEECH_RATE_SETTING_KEY,
  SPEECH_CUSTOM_BASE_URL_KEY,
  SPEECH_CUSTOM_MODEL_KEY,
  SPEECH_CUSTOM_VOICE_UK_KEY,
  SPEECH_CUSTOM_VOICE_US_KEY,
] as const;

/** Provider settings for the OpenAI-compatible source. The key is never here. */
export interface CustomSpeechConfig {
  baseUrl: string;
  model: string;
  voiceUk: string;
  voiceUs: string;
}

export interface SpeechSettings {
  source: SpeechSourceId;
  accent: SpeechAccent;
  rate: number;
  custom: CustomSpeechConfig;
}

/**
 * Dictionary audio is the default because it is the only source with genuinely
 * distinct British and American recordings, and because it sidesteps Windows
 * installs that ship no `en-GB` voice at all.
 */
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  source: "dictionary",
  accent: "us",
  rate: 1,
  custom: { baseUrl: "", model: "", voiceUk: "", voiceUs: "" },
};

export const SPEECH_RATE_RANGE = { min: 0.5, max: 1.5 } as const;

export function parseSpeechSettings(values: Record<string, string | undefined>): SpeechSettings {
  const source = values[SPEECH_SOURCE_SETTING_KEY];
  const accent = values[SPEECH_ACCENT_SETTING_KEY];
  const rate = Number.parseFloat(values[SPEECH_RATE_SETTING_KEY] ?? "");
  const text = (key: string) => (values[key] ?? "").trim();

  return {
    source: source === "system" || source === "dictionary" || source === "custom"
      ? source
      : DEFAULT_SPEECH_SETTINGS.source,
    accent: accent === "uk" || accent === "us" ? accent : DEFAULT_SPEECH_SETTINGS.accent,
    rate: Number.isFinite(rate)
      ? Math.min(SPEECH_RATE_RANGE.max, Math.max(SPEECH_RATE_RANGE.min, rate))
      : DEFAULT_SPEECH_SETTINGS.rate,
    custom: {
      baseUrl: text(SPEECH_CUSTOM_BASE_URL_KEY),
      model: text(SPEECH_CUSTOM_MODEL_KEY),
      voiceUk: text(SPEECH_CUSTOM_VOICE_UK_KEY),
      voiceUs: text(SPEECH_CUSTOM_VOICE_US_KEY),
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
