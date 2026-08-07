import type { SpeechAccent } from "./types";

const ACCENT_LANG: Record<SpeechAccent, string> = {
  uk: "en-gb",
  us: "en-us",
};

/**
 * Every call into `speechSynthesis` goes through here.
 *
 * On macOS 12 / Safari 15 the object passes `"speechSynthesis" in window` but
 * is not fully formed — reading it, calling `getVoices()`, or subscribing can
 * throw. Nothing here is load-bearing: no system voice means the pronunciation
 * button is unavailable, which is a UI state the app already renders. So the
 * whole surface is written to degrade to "no voices" rather than to throw,
 * because these functions run inside `useEffect` bodies and a throw there is
 * not a missing button — it unwinds into the error boundary and takes the
 * whole reader window with it.
 */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function synthesis(): SpeechSynthesis | null {
  return attempt(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    return window.speechSynthesis ?? null;
  }, null);
}

function voices(): SpeechSynthesisVoice[] {
  const target = synthesis();
  if (!target) return [];
  return attempt(() => {
    const list = target.getVoices();
    return Array.isArray(list) ? list : [];
  }, []);
}

export function speechSynthesisSupported(): boolean {
  return synthesis() !== null;
}

/** Platforms disagree on `en-GB` vs `en_GB` vs `en-gb`. */
function normalizeLang(lang: string): string {
  return typeof lang === "string" ? lang.toLowerCase().replace(/_/g, "-") : "";
}

export function englishVoices(): SpeechSynthesisVoice[] {
  return voices().filter((voice) => normalizeLang(voice.lang).startsWith("en"));
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

/** Best installed voice for a BCP-47 language, preferring the OS default. */
export function voiceForLanguage(language: string): SpeechSynthesisVoice | null {
  const target = normalizeLang(language);
  const base = target.split("-")[0];
  const installed = voices();
  const exact = installed.filter((voice) => normalizeLang(voice.lang).startsWith(target));
  const sameLanguage = installed.filter((voice) => normalizeLang(voice.lang).split("-")[0] === base);
  const pool = exact.length > 0 ? exact : sameLanguage;
  return pool.find((voice) => voice.default) ?? pool[0] ?? null;
}

/**
 * WKWebView returns an empty list until the speech engine finishes loading, so
 * the voice inventory must be re-read after `voiceschanged` rather than trusted
 * on first call.
 *
 * Old WebKit builds expose `speechSynthesis` without the `EventTarget` half of
 * its interface, so `addEventListener` is probed rather than assumed and the
 * `onvoiceschanged` handler property is used when it is missing.
 */
export function subscribeToVoices(listener: () => void): () => void {
  const target = synthesis();
  if (!target) return () => {};

  // Some engines only populate the list once it has been asked for.
  voices();

  if (typeof target.addEventListener === "function") {
    const attached = attempt(() => {
      target.addEventListener("voiceschanged", listener);
      return true;
    }, false);
    if (attached) {
      return () => {
        attempt(() => target.removeEventListener("voiceschanged", listener), undefined);
      };
    }
  }

  return attempt(() => {
    const previous = target.onvoiceschanged;
    target.onvoiceschanged = (event) => {
      if (typeof previous === "function") previous.call(target, event);
      listener();
    };
    return () => {
      attempt(() => {
        target.onvoiceschanged = previous;
      }, undefined);
    };
  }, () => {});
}
