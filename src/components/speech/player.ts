import { SpeechError, type SpeechStatus } from "./types";
import type { WordTiming } from "./routing";

export type Playback =
  | { kind: "audio"; text: string; blob: Blob; timings?: WordTiming[] }
  | { kind: "voice"; text: string; voice: SpeechSynthesisVoice | null; rate: number };

/**
 * One unit of playback, produced only when it is nearly due. A long selection is
 * a list of these, so the audio for a later chunk is not fetched — or paid for,
 * on a metered provider — until playback is actually heading there.
 */
export type PlaybackStep = () => Promise<Playback>;

export interface SpeechPlayerState {
  status: SpeechStatus;
  /** Which control started the current playback; others render as idle. */
  ownerId: string | null;
}

/**
 * Where playback has reached. `elapsedMs` is within the current step, not the
 * whole queue, because that is what the step's own word timings are relative to.
 */
export interface PlaybackProgress {
  ownerId: string;
  stepIndex: number;
  elapsedMs: number;
  /** The text of this step, so a follower can locate it without re-chunking. */
  text: string;
  timings: WordTiming[] | null;
}

const ERROR_RESET_MS = 4000;

/**
 * Module-level rather than React state on purpose: both `speechSynthesis` and
 * `HTMLAudioElement` are global, so two open cards must not talk over each
 * other. Starting anything stops whatever was playing.
 */
let state: SpeechPlayerState = { status: "idle", ownerId: null };
const listeners = new Set<(value: SpeechPlayerState) => void>();
const progressListeners = new Set<(value: PlaybackProgress | null) => void>();
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

/**
 * Playback position, for anything that has to keep pace with the audio. `null`
 * means nothing is playing and whatever was following it should be cleared.
 */
export function subscribeToProgress(
  listener: (value: PlaybackProgress | null) => void,
): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

function publishProgress(value: PlaybackProgress | null) {
  for (const listener of progressListeners) listener(value);
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
  publishProgress(null);
  publish({ status: "idle", ownerId: null });
}

function playBlob(blob: Blob, onTime?: (elapsedMs: number) => void): Promise<void> {
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
    // `timeupdate` fires roughly four times a second, which is why following at
    // sentence granularity needs no animation loop.
    if (onTime) audio.ontimeupdate = () => onTime(audio.currentTime * 1000);
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

/** Abandoned prefetches must not surface as unhandled rejections. */
function disown(pending: Promise<unknown> | null) {
  pending?.catch(() => {});
}

/**
 * `plan` picks the sources and splits long text; it may take a network round
 * trip, and runs while the control shows a loading state. An empty plan or a
 * rejection means every source in the chain failed.
 *
 * Steps are played in order with exactly one fetched ahead: without that, every
 * chunk boundary would be a synthesis round trip of silence, which reads as a
 * fault rather than as a pause.
 */
export async function speak(
  ownerId: string,
  plan: () => Promise<PlaybackStep[]>,
): Promise<void> {
  generation += 1;
  teardown();
  const token = generation;
  const isStale = () => token !== generation;

  publish({ status: "loading", ownerId });

  const failed = () => {
    if (isStale()) return;
    publishProgress(null);
    publish({ status: "error", ownerId });
    errorTimer = setTimeout(() => {
      if (!isStale()) publish({ status: "idle", ownerId: null });
    }, ERROR_RESET_MS);
  };

  let steps: PlaybackStep[];
  try {
    steps = await plan();
  } catch {
    failed();
    return;
  }
  if (isStale()) return;
  if (steps.length === 0) {
    failed();
    return;
  }

  let pending: Promise<Playback> | null = steps[0]();
  for (let index = 0; index < steps.length; index += 1) {
    let playback: Playback;
    try {
      playback = await pending!;
    } catch {
      failed();
      return;
    }
    if (isStale()) return;

    // Start the next fetch before playing this one, not after.
    pending = index + 1 < steps.length ? steps[index + 1]() : null;

    publish({ status: "playing", ownerId });
    const timings = playback.kind === "audio" ? playback.timings ?? null : null;
    const { text } = playback;
    publishProgress({ ownerId, stepIndex: index, elapsedMs: 0, text, timings });
    try {
      await (playback.kind === "audio"
        ? playBlob(playback.blob, (elapsedMs) => {
            if (!isStale()) {
              publishProgress({ ownerId, stepIndex: index, elapsedMs, text, timings });
            }
          })
        : playVoice(playback.text, playback.voice, playback.rate));
    } catch {
      disown(pending);
      failed();
      return;
    }
    if (isStale()) {
      disown(pending);
      return;
    }
  }

  publishProgress(null);
  publish({ status: "idle", ownerId: null });
}
