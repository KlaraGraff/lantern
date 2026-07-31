export type SpeechAccent = "uk" | "us";
/** `custom` (user-configured TTS API) arrives in step 2. */
export type SpeechSourceId = "dictionary" | "system";
export type SpeechKind = "word" | "phrase" | "passage";
export type SpeechStatus = "idle" | "loading" | "playing" | "error";

export const SPEECH_SOURCE_SETTING_KEY = "speech_source";
export const SPEECH_ACCENT_SETTING_KEY = "speech_accent";
export const SPEECH_RATE_SETTING_KEY = "speech_rate";

export const SPEECH_SETTING_KEYS = [
  SPEECH_SOURCE_SETTING_KEY,
  SPEECH_ACCENT_SETTING_KEY,
  SPEECH_RATE_SETTING_KEY,
] as const;

export interface SpeechSettings {
  source: SpeechSourceId;
  accent: SpeechAccent;
  rate: number;
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
};

export const SPEECH_RATE_RANGE = { min: 0.5, max: 1.5 } as const;

export function parseSpeechSettings(values: Record<string, string | undefined>): SpeechSettings {
  const source = values[SPEECH_SOURCE_SETTING_KEY];
  const accent = values[SPEECH_ACCENT_SETTING_KEY];
  const rate = Number.parseFloat(values[SPEECH_RATE_SETTING_KEY] ?? "");

  return {
    source: source === "system" || source === "dictionary" ? source : DEFAULT_SPEECH_SETTINGS.source,
    accent: accent === "uk" || accent === "us" ? accent : DEFAULT_SPEECH_SETTINGS.accent,
    rate: Number.isFinite(rate)
      ? Math.min(SPEECH_RATE_RANGE.max, Math.max(SPEECH_RATE_RANGE.min, rate))
      : DEFAULT_SPEECH_SETTINGS.rate,
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
