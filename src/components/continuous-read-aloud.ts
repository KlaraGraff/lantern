/**
 * The reader-facing state machine for continuous read aloud.
 *
 * It deliberately knows neither Foliate nor a speech provider.  The Reader
 * adapts its visible sections into a `ContinuousReadSource`, and reuses the
 * established passage TTS route for `play`.  Keeping the seam here prevents
 * this feature from reading a whole book into memory (or queueing a whole book
 * with speechSynthesis) before the first sentence has even finished.
 */
import type { WordTiming } from "./speech/routing";

/**
 * Where a sentence sits in its chapter, when the source can say so.
 *
 * `remainingCharacters` counts this sentence and everything after it in the
 * chapter, which is what turns an observed speaking pace into "how much longer".
 * A source that cannot work any of this out simply omits the whole object, and
 * the readout then shows only what it does know.
 */
export interface ContinuousReadPosition {
  /** 1-based position within the chapter. */
  index: number;
  /** How many sentences the chapter holds. Never 0 — omit the object instead. */
  total: number;
  /** Characters of speakable text from this sentence to the chapter's end. */
  remainingCharacters: number;
}

export interface ContinuousReadSentence {
  /** Stable while a book is open; normally a CFI range supplied by Foliate. */
  id: string;
  text: string;
  /** A BCP-47 language tag when the source document supplies one. */
  language?: string;
  position?: ContinuousReadPosition;
  /** Nothing precedes this in the book, so "previous sentence" has nowhere to go. */
  atBookStart?: boolean;
  /** Nothing follows it either. Chapter ends are not book ends: reading carries on. */
  atBookEnd?: boolean;
}

export interface ContinuousReadSource {
  first(fromBeginning?: boolean): Promise<ContinuousReadSentence | null>;
  next(after: ContinuousReadSentence): Promise<ContinuousReadSentence | null>;
  previous(before: ContinuousReadSentence): Promise<ContinuousReadSentence | null>;
  /** Turns the page/section only when this particular sentence becomes due. */
  reveal(sentence: ContinuousReadSentence): Promise<void>;
  /**
   * The reader asked for a specific sentence rather than letting the run carry
   * them. A source that stops following after a manual page turn takes this as
   * permission to follow again — the request was for that sentence's page.
   */
  refocus?(): void;
}

export interface ContinuousReadPlayer {
  /** Resolves only after the sentence ended naturally. */
  play(sentence: ContinuousReadSentence, rate: number): Promise<void>;
  /**
   * Starts fetching a sentence's audio before it is due, so the seam between it
   * and the sentence still playing costs no synthesis round trip. At most one
   * sentence is ever warmed, and only while the one before it is speaking — the
   * same "fetch one ahead, and only once playback is heading there" rule the
   * chunk queue already follows on a metered provider.
   */
  prefetch?(sentence: ContinuousReadSentence, rate: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export type ContinuousReadStatus = "idle" | "loading" | "playing" | "paused" | "finished" | "error";

export interface ContinuousReadState {
  status: ContinuousReadStatus;
  current: ContinuousReadSentence | null;
  rate: number;
  /** Lets UI render the compact toolbar capsule after the expanded bar closes. */
  collapsed: boolean;
  /**
   * How far into `current` the voice has reached, 0–1. `null` means it cannot be
   * told — a system voice reports no word timings — and the page then underlines
   * the whole sentence rather than inventing a split.
   */
  progress: number | null;
  /**
   * Characters this voice actually gets through per second at rate 1, measured
   * from finished sentences. `null` until one completes cleanly.
   */
  pace: number | null;
}

const INITIAL_STATE: ContinuousReadState = {
  status: "idle",
  current: null,
  rate: 1,
  collapsed: false,
  progress: null,
  pace: null,
};

/**
 * How finely within-sentence progress is published.
 *
 * Every change repaints the page underline, which costs a foliate annotation
 * round trip. Twelve steps is smooth enough to read as motion on a sentence that
 * takes several seconds, and rare enough not to redraw the overlay every frame.
 */
const PROGRESS_STEPS = 12;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function quantize(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return Math.round(clamp01(fraction) * PROGRESS_STEPS) / PROGRESS_STEPS;
}

/**
 * How far into `sentenceText` the voice has spoken, 0–1, or `null` when there is
 * no honest way to tell.
 *
 * Word timings are the only evidence: `elapsedMs` alone says how long the clip
 * has run, not how much text that covered, and clip duration is not known until
 * it ends. Timings are matched forward through the text so a repeated common
 * word cannot drag the cursor backwards.
 *
 * `stepText` is the chunk the player is speaking, which for a long sentence is
 * only part of it; locating that chunk inside the sentence is what makes the
 * fraction cover the whole sentence rather than the chunk.
 */
export function spokenFraction(
  sentenceText: string,
  stepText: string,
  elapsedMs: number,
  timings: WordTiming[] | null | undefined,
): number | null {
  if (!sentenceText || !timings || timings.length === 0) return null;
  const chunked = Boolean(stepText) && sentenceText.includes(stepText);
  const base = chunked ? sentenceText.indexOf(stepText) : 0;
  const haystack = chunked ? stepText : sentenceText;
  let spoken = 0;
  let cursor = 0;
  for (const timing of timings) {
    const word = timing.text.trim();
    if (!word) continue;
    const at = haystack.indexOf(word, cursor);
    if (at < 0) continue;
    cursor = at + word.length;
    // A word that has not started yet ends the walk: everything after it in the
    // list is also still ahead of the voice.
    if (timing.offsetMs > elapsedMs) break;
    spoken = cursor;
  }
  return clamp01((base + spoken) / sentenceText.length);
}

/** Kana plus the CJK ideograph blocks a book realistically uses. */
const DENSE_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/gu;

/**
 * Characters per second to assume before any sentence has been timed.
 *
 * A CJK character carries roughly a word, so the two scripts differ by about
 * threefold and one shared constant would be wrong for both. This is only the
 * seed — the first completed sentence replaces it with what the voice does.
 */
export function defaultCharactersPerSecond(sampleText: string): number {
  const dense = sampleText.match(DENSE_SCRIPT)?.length ?? 0;
  return dense > 0 && dense * 3 >= sampleText.length ? 5.5 : 15;
}

/**
 * Folds a finished sentence into the measured speaking pace, normalised to rate
 * 1 so changing the rate later rescales the estimate instead of discarding it.
 *
 * Implausible samples are dropped rather than smoothed: a two-character sentence
 * or a sixty-second one says more about the provider's latency than its voice.
 * Returning `previous` unchanged is what keeps a bad sample from moving the
 * readout at all.
 */
export function updatePace(
  previous: number | null,
  characters: number,
  milliseconds: number,
  rate: number,
): number | null {
  if (characters < 8 || milliseconds < 400 || milliseconds > 120_000) return previous;
  if (!Number.isFinite(rate) || rate <= 0) return previous;
  const observed = characters / (milliseconds / 1000) / rate;
  if (!Number.isFinite(observed) || observed <= 0) return previous;
  return previous === null ? observed : previous * 0.7 + observed * 0.3;
}

/**
 * Seconds of speech left, or `null` when the inputs cannot support a number.
 * Callers must not substitute a constant for `null` — a wrong estimate is worse
 * than none, because the user acts on it.
 */
export function estimateRemainingSeconds(
  remainingCharacters: number,
  pace: number | null,
  sampleText: string,
  rate: number,
): number | null {
  if (!Number.isFinite(remainingCharacters) || remainingCharacters <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const base = pace !== null && Number.isFinite(pace) && pace > 0
    ? pace
    : defaultCharactersPerSecond(sampleText);
  const perSecond = base * rate;
  if (!Number.isFinite(perSecond) || perSecond <= 0) return null;
  return remainingCharacters / perSecond;
}

/** What the bar shows beneath the status line. Every field degrades to `null`. */
export interface ContinuousReadReadout {
  /**
   * Chapter progress for the hairline, 0–1. `null` means indeterminate — render
   * the drifting bar, not a zero-width one, which would read as "no progress".
   */
  fraction: number | null;
  /** 1-based position in the chapter, or `null` when the source cannot say. */
  position: { index: number; total: number } | null;
  /** Whole minutes left, never below 1, or `null` when it cannot be estimated. */
  remainingMinutes: number | null;
  /** The current sentence closes the chapter, so time left has nothing to decide. */
  lastSentence: boolean;
}

const EMPTY_READOUT: ContinuousReadReadout = {
  fraction: null,
  position: null,
  remainingMinutes: null,
  lastSentence: false,
};

/**
 * Turns the machine's state into the two things the bar reports: where in the
 * chapter the voice is, and how much of it is left.
 *
 * A position is only used when it is internally consistent — `0 / 0` and
 * `5 / 3` are rendered by no branch here, because a source that reports either
 * has told us nothing and the readout should say nothing.
 */
export function continuousReadReadout(state: ContinuousReadState): ContinuousReadReadout {
  if (state.status === "finished") return { ...EMPTY_READOUT, fraction: 1 };
  const current = state.current;
  if (!current) return EMPTY_READOUT;

  const at = current.position;
  const usable = at !== undefined
    && Number.isInteger(at.index)
    && Number.isInteger(at.total)
    && at.total >= 1
    && at.index >= 1
    && at.index <= at.total;
  if (!usable || !at) return EMPTY_READOUT;

  const spoken = state.progress === null ? 0 : clamp01(state.progress);
  const lastSentence = at.index === at.total;
  const readout: ContinuousReadReadout = {
    fraction: clamp01((at.index - 1 + spoken) / at.total),
    position: { index: at.index, total: at.total },
    remainingMinutes: null,
    lastSentence,
  };
  // On the last sentence the number has nothing left to decide, and after a
  // failure the voice is not consuming text at any rate we can claim to know.
  if (lastSentence || state.status === "error") return readout;

  const left = at.remainingCharacters - current.text.length * spoken;
  const seconds = estimateRemainingSeconds(left, state.pace, current.text, state.rate);
  if (seconds === null) return readout;
  return { ...readout, remainingMinutes: Math.max(1, Math.round(seconds / 60)) };
}

export function supportsContinuousReadAloud(format: string | undefined, supportsReflowSettings: boolean) {
  return format?.toLowerCase() === "epub" && supportsReflowSettings;
}

export class ContinuousReadAloudController {
  private state = INITIAL_STATE;
  private listeners = new Set<(state: ContinuousReadState) => void>();
  /** Every navigation/stop invalidates the async completion it displaced. */
  private generation = 0;
  private readonly source: ContinuousReadSource;
  private readonly player: ContinuousReadPlayer;
  private playerActive = false;
  private pauseRequested = false;
  /**
   * Set when something happened during the current sentence that makes its wall
   * clock a lie about the voice's speed — a pause the user sat through, or a
   * rate change applied part way. Such a sentence is timed but not counted.
   */
  private sampleTainted = false;
  private readonly now: () => number;

  constructor(source: ContinuousReadSource, player: ContinuousReadPlayer, now: () => number = Date.now) {
    this.source = source;
    this.player = player;
    this.now = now;
  }

  snapshot(): ContinuousReadState {
    return this.state;
  }

  subscribe(listener: (state: ContinuousReadState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(next: ContinuousReadState) {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * Looks the next sentence up, and starts fetching its audio, while the current
   * one is still speaking.
   *
   * Doing either of these after the voice falls silent is what made the gap
   * between sentences audible: segmenting the next section and then waiting out
   * a synthesis round trip are both several hundred milliseconds of nothing.
   *
   * The returned promise is the source's own, so a failing `next` still reaches
   * the loop's error branch; the handler attached here only keeps an abandoned
   * lookahead from surfacing as an unhandled rejection.
   */
  private lookAhead(after: ContinuousReadSentence, token: number): Promise<ContinuousReadSentence | null> {
    const pending = this.source.next(after);
    pending.then(
      (next) => {
        if (next && token === this.generation) this.player.prefetch?.(next, this.state.rate);
      },
      () => {},
    );
    return pending;
  }

  private async playFrom(sentence: ContinuousReadSentence, token: number): Promise<void> {
    let current: ContinuousReadSentence | null = sentence;
    while (current && token === this.generation) {
      if (this.pauseRequested) {
        this.publish({ ...this.state, status: "paused", current });
        return;
      }
      // A new sentence starts with no reported progress: carrying the previous
      // one's fraction over would underline text this sentence has not reached.
      this.publish({ ...this.state, status: "loading", current, progress: null });
      try {
        // Reveal is intentionally immediately before playback, not while the
        // preceding sentence plays: section access remains streaming.
        await this.source.reveal(current);
        if (token !== this.generation) return;
        if (this.pauseRequested) {
          this.publish({ ...this.state, status: "paused", current });
          return;
        }
        this.publish({ ...this.state, status: "playing", current });
        this.playerActive = true;
        this.sampleTainted = false;
        const startedAt = this.now();
        /** The sentence after this one, looked up and synthesised while it plays. */
        let upcoming: Promise<ContinuousReadSentence | null>;
        try {
          const playing = this.player.play(current, this.state.rate);
          upcoming = this.lookAhead(current, token);
          await playing;
        } finally {
          this.playerActive = false;
        }
        // Only a sentence that ran start to finish at one rate says anything
        // about how fast this voice reads, and only that measurement is allowed
        // to move the "time left" estimate.
        if (!this.sampleTainted && token === this.generation) {
          const pace = updatePace(this.state.pace, current.text.length, this.now() - startedAt, this.state.rate);
          if (pace !== this.state.pace) this.publish({ ...this.state, pace });
        }
        if (token !== this.generation || this.pauseRequested) return;
        current = await upcoming;
        if (token !== this.generation) return;
        if (current && this.pauseRequested) {
          this.publish({ ...this.state, status: "paused", current });
          return;
        }
      } catch {
        if (token === this.generation) this.publish({ ...this.state, status: "error", current, collapsed: false });
        return;
      }
    }
    if (token === this.generation) this.publish({ ...this.state, status: "finished", current: null, collapsed: false });
  }

  async start(fromBeginning = false): Promise<void> {
    this.player.stop();
    this.pauseRequested = false;
    const token = ++this.generation;
    this.publish({ ...this.state, status: "loading", current: null, collapsed: false, progress: null });
    try {
      const first = await this.source.first(fromBeginning);
      if (token !== this.generation) return;
      if (!first) {
        this.publish({ ...this.state, status: "finished", current: null, collapsed: false });
        return;
      }
      await this.playFrom(first, token);
    } catch {
      if (token === this.generation) this.publish({ ...this.state, status: "error", current: null, collapsed: false });
    }
  }

  pause(): void {
    if (this.state.status !== "playing" && this.state.status !== "loading") return;
    this.pauseRequested = true;
    this.sampleTainted = true;
    this.player.pause();
    this.publish({ ...this.state, status: "paused" });
  }

  resume(): void {
    if (this.state.status !== "paused" || !this.state.current) return;
    this.pauseRequested = false;
    if (this.playerActive) {
      this.player.resume();
      this.publish({ ...this.state, status: "playing" });
      return;
    }
    const token = ++this.generation;
    this.publish({ ...this.state, status: "loading" });
    void this.playFrom(this.state.current, token);
  }

  stop(): void {
    ++this.generation;
    this.pauseRequested = false;
    this.player.stop();
    this.publish({ ...this.state, status: "idle", current: null, collapsed: false, progress: null });
  }

  /** Mirrors the shared speech player's parked state without pausing a foreground word. */
  syncPlayerPaused(): void {
    if (this.state.status !== "playing" && this.state.status !== "loading") return;
    this.pauseRequested = true;
    this.sampleTainted = true;
    this.publish({ ...this.state, status: "paused" });
  }

  /** Mirrors the shared player resuming this owner after a foreground word ends. */
  syncPlayerPlaying(): void {
    if (this.state.status !== "paused" || !this.playerActive) return;
    this.pauseRequested = false;
    this.publish({ ...this.state, status: "playing" });
  }

  /** Another detached passage replaced this run; do not cancel the replacement. */
  abandon(): void {
    ++this.generation;
    this.pauseRequested = false;
    this.publish({ ...this.state, status: "idle", current: null, collapsed: false, progress: null });
  }

  async skip(direction: "previous" | "next"): Promise<void> {
    const current = this.state.current;
    if (!current) return this.start();
    const token = ++this.generation;
    this.pauseRequested = false;
    this.player.stop();
    // Pressing skip is a request for a sentence, not just for its audio: a
    // source that had stopped following the reader's page owes them this one.
    this.source.refocus?.();
    this.publish({ ...this.state, status: "loading", progress: null });
    try {
      const target = direction === "previous"
        ? await this.source.previous(current)
        : await this.source.next(current);
      if (token !== this.generation) return;
      if (!target) {
        this.publish({ ...this.state, status: "finished", current: null, collapsed: false });
        return;
      }
      await this.playFrom(target, token);
    } catch {
      if (token === this.generation) this.publish({ ...this.state, status: "error", current, collapsed: false });
    }
  }

  setRate(rate: number): void {
    // The native and remote engines both treat rate as a playback property;
    // applying it to the next sentence avoids restarting a sentence mid-word.
    // The sentence in flight is therefore spoken at two speeds and cannot be
    // timed; the estimate keeps whatever it already measured until the next one.
    this.sampleTainted = true;
    this.publish({ ...this.state, rate: Math.min(2, Math.max(0.5, rate)) });
  }

  /**
   * How far the voice has got into the current sentence, 0–1, or `null` when the
   * engine gives nothing to follow.
   *
   * Quantised, and dropped when it does not move: this drives a page repaint,
   * and the audio reports its position far more often than the underline can
   * usefully change.
   */
  reportProgress(fraction: number | null): void {
    if (!this.state.current) return;
    if (this.state.status !== "playing" && this.state.status !== "paused") return;
    const next = quantize(fraction);
    if (next === this.state.progress) return;
    this.publish({ ...this.state, progress: next });
  }

  setCollapsed(collapsed: boolean): void {
    // Terminal states (finished/error/idle) are never collapsed: the expanded
    // bar is the only surface that can reach them, so collapsing here would
    // leave nothing rendered but the state still claiming "collapsed".
    if (collapsed && (this.state.status === "finished" || this.state.status === "error" || this.state.status === "idle")) return;
    this.publish({ ...this.state, collapsed });
  }
}
