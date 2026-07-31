import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { fetchDictionaryAudio } from "../components/speech/dictionary-source";
import {
  cancelSpeech,
  playerState,
  speak as playerSpeak,
  subscribeToPlayer,
  type Playback,
} from "../components/speech/player";
import {
  ensureSpeechSettings,
  speechSettings,
  subscribeToSpeechSettings,
  updateSpeechSettings,
} from "../components/speech/settings-store";
import {
  accentAvailability,
  fallbackVoice,
  speechSynthesisSupported,
  subscribeToVoices,
  voiceForAccent,
} from "../components/speech/system-voices";
import {
  SPEECH_ACCENT_SETTING_KEY,
  SpeechError,
  type SpeechAccent,
  type SpeechKind,
  type SpeechSettings,
  type SpeechStatus,
} from "../components/speech/types";

function systemPlayback(text: string, settings: SpeechSettings): Playback {
  if (!speechSynthesisSupported()) throw new SpeechError("unsupported");
  const voice = voiceForAccent(settings.accent) ?? fallbackVoice();
  return { kind: "voice", text, voice, rate: settings.rate };
}

/**
 * Dictionary audio only covers corpus entries — a 19-character non-entry fails
 * while a 17-character idiom succeeds — so a miss is routine and falls through
 * to system voices rather than surfacing an error. Whole passages skip the
 * dictionary entirely; it has never had audio for them.
 */
async function resolvePlayback(
  text: string,
  kind: SpeechKind,
  settings: SpeechSettings,
): Promise<Playback> {
  if (settings.source === "dictionary" && kind !== "passage") {
    try {
      return { kind: "audio", blob: await fetchDictionaryAudio(text, settings.accent) };
    } catch {
      // Falls through to system voices.
    }
  }
  return systemPlayback(text, settings);
}

export interface UseSpeech {
  status: SpeechStatus;
  accent: SpeechAccent;
  /** Whether the OS has a voice for each accent. Only limits the system source. */
  accentAvailable: Record<SpeechAccent, boolean>;
  /** True when playback depends on OS voices, so a missing accent matters. */
  dependsOnSystemVoices: boolean;
  speak: (text: string, kind?: SpeechKind) => void;
  setAccent: (accent: SpeechAccent) => Promise<void>;
  stop: () => void;
}

export function useSpeech(): UseSpeech {
  const ownerId = useId();
  const [settings, setSettings] = useState(speechSettings);
  const [player, setPlayer] = useState(playerState);
  const [voicesRevision, setVoicesRevision] = useState(0);

  useEffect(() => {
    ensureSpeechSettings();
    return subscribeToSpeechSettings(setSettings);
  }, []);

  useEffect(() => subscribeToPlayer(setPlayer), []);

  useEffect(() => subscribeToVoices(() => setVoicesRevision((value) => value + 1)), []);

  // Stop playback when the card that started it goes away.
  useEffect(() => () => {
    if (playerState().ownerId === ownerId) cancelSpeech();
  }, [ownerId]);

  const accentAvailable = useMemo(
    () => accentAvailability(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on voiceschanged
    [voicesRevision],
  );

  const speak = useCallback((text: string, kind: SpeechKind = "word") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void playerSpeak(ownerId, () => resolvePlayback(trimmed, kind, speechSettings()));
  }, [ownerId]);

  const setAccent = useCallback(async (accent: SpeechAccent) => {
    await updateSpeechSettings({ [SPEECH_ACCENT_SETTING_KEY]: accent });
  }, []);

  return {
    status: player.ownerId === ownerId ? player.status : "idle",
    accent: settings.accent,
    accentAvailable,
    dependsOnSystemVoices: settings.source === "system",
    speak,
    setAccent,
    stop: cancelSpeech,
  };
}
