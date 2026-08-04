import type { Playback } from "./player.ts";
import {
  fallbackVoice,
  speechSynthesisSupported,
  voiceForAccent,
  voiceForLanguage,
} from "./system-voices.ts";
import { speechLanguage } from "./language.ts";
import { SpeechError, type SpeechSettings } from "./types.ts";

export function systemPlayback(
  text: string,
  settings: SpeechSettings,
  language?: string,
  rate = settings.rate,
): Playback {
  if (!speechSynthesisSupported()) throw new SpeechError("unsupported");
  const resolvedLanguage = speechLanguage(language, text);
  const voice = resolvedLanguage === "en"
    ? voiceForAccent(settings.accent) ?? fallbackVoice()
    : voiceForLanguage(resolvedLanguage);
  return { kind: "voice", text, voice, language: resolvedLanguage, rate };
}
