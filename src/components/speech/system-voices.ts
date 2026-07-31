import type { SpeechAccent } from "./types";

const ACCENT_LANG: Record<SpeechAccent, string> = {
  uk: "en-gb",
  us: "en-us",
};

function synthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis;
}

export function speechSynthesisSupported(): boolean {
  return synthesis() !== null;
}

/** Platforms disagree on `en-GB` vs `en_GB` vs `en-gb`. */
function normalizeLang(lang: string): string {
  return lang.toLowerCase().replace(/_/g, "-");
}

export function englishVoices(): SpeechSynthesisVoice[] {
  return synthesis()?.getVoices().filter((voice) => normalizeLang(voice.lang).startsWith("en")) ?? [];
}

export function voiceForAccent(accent: SpeechAccent): SpeechSynthesisVoice | null {
  const target = ACCENT_LANG[accent];
  const pool = englishVoices().filter((voice) => normalizeLang(voice.lang).startsWith(target));
  // macOS lists novelty voices (Zarvox, Bubbles, Bad News) in the same array as
  // the real ones and the order is OS-determined, so the system default wins
  // when it matches rather than whatever happens to come first.
  return pool.find((voice) => voice.default) ?? pool[0] ?? null;
}

/**
 * Windows commonly ships US English only. The UI dims the missing accent rather
 * than hiding it, so the user learns the option exists and can install it.
 */
export function accentAvailability(): Record<SpeechAccent, boolean> {
  return {
    uk: voiceForAccent("uk") !== null,
    us: voiceForAccent("us") !== null,
  };
}

/** Any English voice, for when the requested accent is not installed. */
export function fallbackVoice(): SpeechSynthesisVoice | null {
  return englishVoices()[0] ?? null;
}

/**
 * WKWebView returns an empty list until the speech engine finishes loading, so
 * the voice inventory must be re-read after `voiceschanged` rather than trusted
 * on first call.
 */
export function subscribeToVoices(listener: () => void): () => void {
  const target = synthesis();
  if (!target) return () => {};
  target.addEventListener("voiceschanged", listener);
  // Some engines only populate the list once it has been asked for.
  target.getVoices();
  return () => target.removeEventListener("voiceschanged", listener);
}
