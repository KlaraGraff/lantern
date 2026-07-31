import { SpeechError, type SpeechStatus } from "./types";

export type Playback =
  | { kind: "audio"; blob: Blob }
  | { kind: "voice"; text: string; voice: SpeechSynthesisVoice | null; rate: number };

export interface SpeechPlayerState {
  status: SpeechStatus;
  /** Which control started the current playback; others render as idle. */
  ownerId: string | null;
}

const ERROR_RESET_MS = 4000;

/**
 * Module-level rather than React state on purpose: both `speechSynthesis` and
 * `HTMLAudioElement` are global, so two open cards must not talk over each
 * other. Starting anything stops whatever was playing.
 */
let state: SpeechPlayerState = { status: "idle", ownerId: null };
const listeners = new Set<(value: SpeechPlayerState) => void>();
/** Bumped on every new request so stale async work can detect it lost the race. */
let generation = 0;
let element: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;

function publish(next: SpeechPlayerState) {
  state = next;
  for (const listener of listeners) listener(state);
}

export function playerState(): SpeechPlayerState {
  return state;
}

export function subscribeToPlayer(listener: (value: SpeechPlayerState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function releaseObjectUrl() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

function teardown() {
  if (errorTimer) {
    clearTimeout(errorTimer);
    errorTimer = null;
  }
  if (element) {
    element.pause();
    element.removeAttribute("src");
    element.load();
    element = null;
  }
  releaseObjectUrl();
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/** Stops playback and invalidates any request still in flight. */
export function cancelSpeech() {
  generation += 1;
  teardown();
  publish({ status: "idle", ownerId: null });
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    objectUrl = url;
    const audio = new Audio(url);
    element = audio;
    const settle = (done: () => void) => {
      if (element === audio) {
        element = null;
        releaseObjectUrl();
      }
      done();
    };
    audio.onended = () => settle(resolve);
    audio.onerror = () => settle(() => reject(new SpeechError("unavailable")));
    audio.play().catch(() => settle(() => reject(new SpeechError("unavailable"))));
  });
}

function playVoice(text: string, voice: SpeechSynthesisVoice | null, rate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      reject(new SpeechError("unsupported"));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = rate;
    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      // Interrupting the previous utterance is how switching accents works, so
      // those are successful outcomes, not failures.
      if (event.error === "canceled" || event.error === "interrupted") resolve();
      else reject(new SpeechError("unavailable"));
    };
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * `resolve` picks a source and may take a network round trip; it runs while the
 * control shows a loading state. Rejecting means every source in the chain
 * failed.
 */
export async function speak(ownerId: string, resolve: () => Promise<Playback>): Promise<void> {
  generation += 1;
  teardown();
  const token = generation;
  const isStale = () => token !== generation;

  publish({ status: "loading", ownerId });

  const failed = () => {
    if (isStale()) return;
    publish({ status: "error", ownerId });
    errorTimer = setTimeout(() => {
      if (!isStale()) publish({ status: "idle", ownerId: null });
    }, ERROR_RESET_MS);
  };

  let playback: Playback;
  try {
    playback = await resolve();
  } catch {
    failed();
    return;
  }
  if (isStale()) return;

  publish({ status: "playing", ownerId });
  try {
    await (playback.kind === "audio"
      ? playBlob(playback.blob)
      : playVoice(playback.text, playback.voice, playback.rate));
  } catch {
    failed();
    return;
  }
  if (!isStale()) publish({ status: "idle", ownerId: null });
}
