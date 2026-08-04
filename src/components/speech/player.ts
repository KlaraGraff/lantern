// Extension spelled out because the unit tests load this module through Node's
// type stripping, which does not resolve extensionless paths.
import { SpeechError, type SpeechStatus } from "./types.ts";
import type { WordTiming } from "./routing";

export type Playback =
  | { kind: "audio"; text: string; blob: Blob; timings?: WordTiming[]; rate?: number }
  | { kind: "voice"; text: string; voice: SpeechSynthesisVoice | null; language?: string; rate: number };

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
  /**
   * Playback that has left its starting control behind, so dismissing that
   * control must not stop it and something else has to offer the stop.
   */
  detached: boolean;
  /**
   * A detached playback stopped mid-clip and waiting to be picked up again.
   *
   * Separate from `status` because the two genuinely disagree: a word played
   * while a passage waits owns the foreground state, and the passage still has
   * to be resumable from somewhere.
   */
  paused: { ownerId: string } | null;
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
let state: SpeechPlayerState = { status: "idle", ownerId: null, detached: false, paused: null };
const listeners = new Set<(value: SpeechPlayerState) => void>();
const progressListeners = new Set<(value: PlaybackProgress | null) => void>();
/** Bumped on every new request so stale async work can detect it lost the race. */
let generation = 0;
let element: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A queue caught in the act: everything needed to stop it where it stands and
 * start it again from there.
 *
 * `playback` and `ahead` are the clips already fetched, kept across a pause so
 * resuming costs no round trip and no second charge on a metered provider.
 */
interface Run {
  /** The generation that owns this run; it is stale once `generation` moves on. */
  token: number;
  ownerId: string;
  detached: boolean;
  steps: PlaybackStep[];
  /** Which step is playing. */
  index: number;
  /** The clip for `index`. */
  playback: Playback;
  /** The prefetched clip for `index + 1`, or null when this is the last step. */
  ahead: Promise<Playback> | null;
  /** How far into the clip playback reached. Only audio can act on it. */
  elapsedMs: number;
  /** Stops the clip where it is; audio resolves as parked, a voice is held. */
  park: () => void;
  /**
   * True while the synthesizer is holding a paused utterance for this run — its
   * queue loop never left the await, so resuming is just letting the engine go.
   */
  held: boolean;
  /** Set when the run was evicted while held and must not carry on. */
  abandoned: boolean;
}

/** The run currently making sound, if any. */
let active: Run | null = null;
/** A detached run stopped mid-clip, waiting to be resumed. */
let parked: Run | null = null;
/** A pause that arrived before there was a clip to pause. */
let pausePending: { ownerId: string; detached: boolean } | null = null;

function hasSynthesizer(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function publish(next: Omit<SpeechPlayerState, "paused">) {
  const owner = parked?.ownerId ?? pausePending?.ownerId ?? null;
  state = { ...next, paused: owner === null ? null : { ownerId: owner } };
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

function discardElement() {
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
  element = null;
  releaseObjectUrl();
}

/**
 * Lets go of a paused utterance the synthesizer is still holding.
 *
 * `speechSynthesis` is one global engine, not an object per utterance: pausing
 * it pauses everything, and anything spoken while it is paused queues silently
 * behind the held utterance. So whoever needs the engine evicts the hold first,
 * and that run degrades from "resume in place" to "re-speak this step" — which
 * is why a parked run records its step index and not only an offset.
 */
function evictVoiceHold() {
  const held = parked;
  if (!held?.held) return;
  held.held = false;
  held.abandoned = true;
  held.elapsedMs = 0;
  if (active === held) active = null;
  if (hasSynthesizer()) {
    // Cancelling a paused engine leaves it paused, so it has to be let go first
    // or the next utterance never starts.
    window.speechSynthesis.resume();
    window.speechSynthesis.cancel();
  }
}

/**
 * Stops whatever is making sound now. A voice hold belongs to a parked run
 * rather than to the foreground, so it survives unless the caller says
 * otherwise.
 */
function stopForeground(keepVoiceHold: boolean) {
  if (errorTimer) {
    clearTimeout(errorTimer);
    errorTimer = null;
  }
  discardElement();
  if (!hasSynthesizer()) return;
  if (keepVoiceHold) return;
  window.speechSynthesis.resume();
  window.speechSynthesis.cancel();
}

/** Stops playback and invalidates any request still in flight. */
export function cancelSpeech() {
  generation += 1;
  active = null;
  parked = null;
  pausePending = null;
  stopForeground(false);
  publishProgress(null);
  publish({ status: "idle", ownerId: null, detached: false });
}

/**
 * Stops playback where it stands, keeping enough of it to carry on later.
 *
 * Only detached playback can be paused. A word is over in about a second, so a
 * pause control for it would be one nobody could hit in time.
 */
export function pauseSpeech() {
  if (parked || pausePending) return;
  if (!state.detached || !state.ownerId) return;
  if (state.status !== "playing" && state.status !== "loading") return;

  const run = active;
  if (!run) {
    // The first clip is still being fetched. Record the request and let the
    // queue park it on arrival rather than playing it.
    pausePending = { ownerId: state.ownerId, detached: state.detached };
    publish({ status: "paused", ownerId: state.ownerId, detached: state.detached });
    return;
  }
  parked = run;
  run.park();
  publish({ status: "paused", ownerId: run.ownerId, detached: run.detached });
}

/** Picks a paused playback back up. Does nothing when there is none. */
export function resumeSpeech() {
  const run = parked;
  if (!run) {
    if (!pausePending) return;
    const pending = pausePending;
    pausePending = null;
    // Still nothing fetched, so this goes back to waiting rather than to sound.
    publish({ status: "loading", ownerId: pending.ownerId, detached: pending.detached });
    return;
  }
  parked = null;

  if (run.held) {
    run.held = false;
    // Its queue loop never left the await, so restoring the token it was started
    // with is what makes that loop live again — no other run shares it.
    stopForeground(true);
    generation = run.token;
    active = run;
    publish({ status: "playing", ownerId: run.ownerId, detached: run.detached });
    if (hasSynthesizer()) window.speechSynthesis.resume();
    return;
  }

  stopForeground(false);
  generation += 1;
  publish({ status: "playing", ownerId: run.ownerId, detached: run.detached });
  void runQueue(generation, {
    ownerId: run.ownerId,
    detached: run.detached,
    steps: run.steps,
    index: run.index,
    elapsedMs: run.elapsedMs,
    current: Promise.resolve(run.playback),
    ahead: run.ahead,
  });
}

type ClipOutcome = "ended" | "parked";

function seekThenPlay(audio: HTMLAudioElement, startMs: number, onFailure: () => void) {
  const start = () => {
    audio.play().catch(onFailure);
  };
  if (startMs <= 0) {
    start();
    return;
  }
  // `currentTime` only takes once the duration is known, and seeking after
  // `play()` would let the opening of the clip escape before the jump lands.
  const seek = () => {
    try {
      audio.currentTime = startMs / 1000;
    } catch {
      // A source that refuses the seek still plays, just from the beginning.
    }
    start();
  };
  if (audio.readyState >= 1) seek();
  else audio.addEventListener("loadedmetadata", seek, { once: true });
}

function playBlob(
  run: Run,
  playback: Extract<Playback, { kind: "audio" }>,
  onTime: (elapsedMs: number) => void,
): Promise<ClipOutcome> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(playback.blob);
    objectUrl = url;
    const audio = new Audio(url);
    audio.playbackRate = playback.rate ?? 1;
    element = audio;
    const settle = (done: () => void) => {
      if (element === audio) discardElement();
      done();
    };
    run.park = () => {
      audio.pause();
      run.elapsedMs = audio.currentTime * 1000;
      // The element goes; the blob it was built from is what a resume needs, and
      // that lives on in the run.
      if (element === audio) discardElement();
      if (active === run) active = null;
      resolve("parked");
    };
    // `timeupdate` fires roughly four times a second, which is why following at
    // sentence granularity needs no animation loop.
    audio.ontimeupdate = () => onTime(audio.currentTime * 1000);
    audio.onended = () => settle(() => resolve("ended"));
    audio.onerror = () => settle(() => reject(new SpeechError("unavailable")));
    seekThenPlay(audio, run.elapsedMs, () => settle(() => reject(new SpeechError("unavailable"))));
  });
}

function playVoice(
  run: Run,
  playback: Extract<Playback, { kind: "voice" }>,
): Promise<ClipOutcome> {
  return new Promise((resolve, reject) => {
    if (!hasSynthesizer()) {
      reject(new SpeechError("unsupported"));
      return;
    }
    evictVoiceHold();
    const utterance = new SpeechSynthesisUtterance(playback.text);
    if (playback.voice) {
      utterance.voice = playback.voice;
      utterance.lang = playback.voice.lang;
    } else if (playback.language) {
      utterance.lang = playback.language;
    }
    utterance.rate = playback.rate;
    run.park = () => {
      // The utterance stays inside the engine, so this promise simply does not
      // settle until someone resumes — the queue waits exactly where it was.
      run.held = true;
      window.speechSynthesis.pause();
    };
    utterance.onend = () => resolve("ended");
    utterance.onerror = (event) => {
      // Interrupting the previous utterance is how switching accents works, so
      // those are successful outcomes, not failures.
      if (event.error === "canceled" || event.error === "interrupted") resolve("ended");
      else reject(new SpeechError("unavailable"));
    };
    window.speechSynthesis.speak(utterance);
  });
}

function playClip(run: Run, onTime: (elapsedMs: number) => void): Promise<ClipOutcome> {
  return run.playback.kind === "audio"
    ? playBlob(run, run.playback, onTime)
    : playVoice(run, run.playback);
}

/** Abandoned prefetches must not surface as unhandled rejections. */
function disown(pending: Promise<unknown> | null) {
  pending?.catch(() => {});
}

interface QueueSeed {
  ownerId: string;
  detached: boolean;
  steps: PlaybackStep[];
  index: number;
  elapsedMs: number;
  /** The clip for `index`, already in flight or already in hand. */
  current: Promise<Playback>;
  /** The clip for `index + 1` when a pause preserved it, otherwise null. */
  ahead: Promise<Playback> | null;
}

/**
 * Plays steps in order with exactly one fetched ahead: without that, every chunk
 * boundary would be a synthesis round trip of silence, which reads as a fault
 * rather than as a pause.
 *
 * Written to be re-enterable from the middle, because that is what resuming is.
 */
async function runQueue(token: number, seed: QueueSeed): Promise<void> {
  const { ownerId, detached, steps } = seed;
  const isStale = () => token !== generation;
  const failed = () => {
    if (isStale()) return;
    active = null;
    // Only this queue's own suspended state is this queue's to throw away. A
    // word that fails must not take the reading parked behind it down too.
    if (parked?.ownerId === ownerId) parked = null;
    if (pausePending?.ownerId === ownerId) pausePending = null;
    publishProgress(null);
    publish({ status: "error", ownerId, detached });
    errorTimer = setTimeout(() => {
      if (!isStale()) publish({ status: "idle", ownerId: null, detached: false });
    }, ERROR_RESET_MS);
  };

  let index = seed.index;
  let offsetMs = seed.elapsedMs;
  let current = seed.current;
  let ahead = seed.ahead;

  while (index < steps.length) {
    let playback: Playback;
    try {
      playback = await current;
    } catch {
      disown(ahead);
      failed();
      return;
    }
    if (isStale()) {
      disown(ahead);
      return;
    }

    // Start the next fetch before playing this one, not after.
    if (!ahead && index + 1 < steps.length) ahead = steps[index + 1]();

    const run: Run = {
      token,
      ownerId,
      detached,
      steps,
      index,
      playback,
      ahead,
      elapsedMs: offsetMs,
      park: () => {},
      held: false,
      abandoned: false,
    };
    active = run;

    if (pausePending) {
      // Pause beat the audio here. Park the clip instead of playing it, so
      // resuming starts it from the top rather than fetching it again.
      pausePending = null;
      parked = run;
      active = null;
      publish({ status: "paused", ownerId, detached });
      return;
    }

    publish({ status: "playing", ownerId, detached });
    const timings = playback.kind === "audio" ? playback.timings ?? null : null;
    const { text } = playback;
    publishProgress({ ownerId, stepIndex: index, elapsedMs: offsetMs, text, timings });

    let outcome: ClipOutcome;
    try {
      outcome = await playClip(run, (elapsedMs) => {
        run.elapsedMs = elapsedMs;
        if (!isStale()) publishProgress({ ownerId, stepIndex: index, elapsedMs, text, timings });
      });
    } catch {
      disown(ahead);
      failed();
      return;
    }
    // A parked run owns its own record; an abandoned one had it taken away.
    if (outcome === "parked" || run.abandoned || isStale()) {
      disown(ahead);
      return;
    }

    if (active === run) active = null;
    index += 1;
    offsetMs = 0;
    if (index < steps.length) {
      current = ahead!;
      ahead = null;
    }
  }

  active = null;
  publishProgress(null);
  publish({ status: "idle", ownerId: null, detached: false });
}

/**
 * `plan` picks the sources and splits long text; it may take a network round
 * trip, and runs while the control shows a loading state. An empty plan or a
 * rejection means every source in the chain failed.
 */
export async function speak(
  ownerId: string,
  plan: () => Promise<PlaybackStep[]>,
  { detached = false }: { detached?: boolean } = {},
): Promise<void> {
  if (detached) {
    // A new passage replaces everything, a parked one included.
    active = null;
    parked = null;
    pausePending = null;
    stopForeground(false);
  } else if (active?.detached) {
    // A word played over a running passage parks it rather than killing it, so
    // one pronunciation can be heard and the reading picked back up after.
    //
    // Only once the passage is actually making sound: while its first clip is
    // still being fetched there is no position to keep, and the word wins.
    parked = active;
    active.park();
  } else {
    // Anything already parked stays parked — a word does not discard it.
    active = null;
    stopForeground(Boolean(parked?.held));
  }

  generation += 1;
  const token = generation;
  publish({ status: "loading", ownerId, detached });

  let steps: PlaybackStep[];
  try {
    steps = await plan();
  } catch {
    if (token === generation) {
      publishProgress(null);
      publish({ status: "error", ownerId, detached });
      errorTimer = setTimeout(() => {
        if (token === generation) publish({ status: "idle", ownerId: null, detached: false });
      }, ERROR_RESET_MS);
    }
    return;
  }
  if (token !== generation) return;
  if (steps.length === 0) {
    publishProgress(null);
    publish({ status: "error", ownerId, detached });
    errorTimer = setTimeout(() => {
      if (token === generation) publish({ status: "idle", ownerId: null, detached: false });
    }, ERROR_RESET_MS);
    return;
  }

  await runQueue(token, {
    ownerId,
    detached,
    steps,
    index: 0,
    elapsedMs: 0,
    current: steps[0](),
    ahead: null,
  });
}
