import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  fetchCustomAudio,
  fetchDictionaryAudio,
  fetchEdgeAudio,
} from "../components/speech/remote-audio";
import {
  cancelSpeech,
  pauseSpeech,
  playerState,
  resumeSpeech,
  speak as playerSpeak,
  subscribeToPlayer,
  type Playback,
  type PlaybackStep,
} from "../components/speech/player";
import {
  chunkForSynthesis,
  planSources,
  playbackDetaches,
  type SpeechRoute,
} from "../components/speech/routing";
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
 * What the synthesizer commands accept in one request, mirroring
 * `MAX_SYNTHESIZER_TEXT_CHARS` in `commands/speech.rs`. Anything longer is split
 * here rather than rejected there — a passage silently degrading to system
 * voices is exactly the failure this replaces.
 */
const MAX_SYNTHESIS_CHARS = 2000;

/**
 * How long the dictionary may hold up a playback it is not the only source for.
 *
 * A miss is a fast answer — the corpus replies "no entry" in a few hundred
 * milliseconds — so the normal cost of asking is small, and the backend caches
 * the miss so it is paid once per text ever. The cap is for the other case: a
 * hung connection would otherwise stall playback for the full ten-second
 * request timeout before anything else was tried.
 *
 * Losing the race does not cancel the request. It runs on, and a hit that merely
 * arrived late still lands in the cache, so the next attempt has it.
 */
const OPTIONAL_DICTIONARY_MS = 2000;

function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SPEECH_SOURCE_SLOW")), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Plays one chunk through the first source in `plan` that answers.
 *
 * Dictionary audio only covers corpus entries — a 19-character non-entry fails
 * while a 17-character idiom succeeds — so a miss is routine and falls through
 * rather than surfacing an error.
 *
 * The custom provider is metered, which is why `planSources` never reaches it
 * automatically: spending the user's money as a silent fallback would be a nasty
 * surprise. The Edge source is free but unofficial, and the fallback behind it is
 * what makes it safe to offer — when Microsoft breaks it, playback gets worse
 * rather than stopping.
 */
async function playbackForChunk(
  text: string,
  plan: SpeechRoute[],
  settings: SpeechSettings,
): Promise<Playback> {
  for (const [index, route] of plan.entries()) {
    if (route === "system") return systemPlayback(text, settings);
    const isLast = index === plan.length - 1;
    try {
      switch (route) {
        case "dictionary": {
          const pending = fetchDictionaryAudio(text, settings.accent);
          const blob = isLast ? await pending : await withDeadline(pending, OPTIONAL_DICTIONARY_MS);
          return { kind: "audio", text, blob };
        }
        case "edge": {
          const { blob, timings } = await fetchEdgeAudio(text, settings.accent);
          return { kind: "audio", text, blob, timings };
        }
        case "custom":
          return { kind: "audio", text, blob: await fetchCustomAudio(text, settings.accent) };
      }
    } catch {
      // Try the next source in the plan.
    }
  }
  return systemPlayback(text, settings);
}

/**
 * The steps one selection becomes. A word is one step; a passage past the
 * request cap is several, and the player fetches one ahead so the seams between
 * them are inaudible.
 */
function planPlayback(
  text: string,
  kind: SpeechKind,
  settings: SpeechSettings,
): PlaybackStep[] {
  const plan = planSources(kind, settings);
  // System voices read any length, so splitting would only insert pauses.
  const chunks = plan.every((route) => route === "system")
    ? [text]
    : chunkForSynthesis(text, MAX_SYNTHESIS_CHARS);
  return chunks.map((chunk) => () => playbackForChunk(chunk, plan, settings));
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
  /** Only ever does anything for a passage; see `pauseSpeech`. */
  pause: () => void;
  resume: () => void;
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

  // A card going away stops what it started — unless playback was detached,
  // which is how a passage survives the selection menu closing on the very next
  // click. That menu has to close: it blocks paging while open, and the floating
  // control is what offers the stop from then on.
  //
  // A paused passage is detached too, but its state has moved to `paused`, so it
  // has to be recognised separately or dismissing the card that started it would
  // throw away the position it is waiting at.
  useEffect(() => () => {
    const { ownerId: current, detached, paused } = playerState();
    if (paused?.ownerId === ownerId) return;
    if (current === ownerId && !detached) cancelSpeech();
  }, [ownerId]);

  const accentAvailable = useMemo(
    () => accentAvailability(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on voiceschanged
    [voicesRevision],
  );

  const speak = useCallback((text: string, kind: SpeechKind = "word") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void playerSpeak(
      ownerId,
      async () => planPlayback(trimmed, kind, speechSettings()),
      { detached: playbackDetaches(kind) },
    );
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
    pause: pauseSpeech,
    resume: resumeSpeech,
  };
}
