/**
 * The reader-facing state machine for continuous read aloud.
 *
 * It deliberately knows neither Foliate nor a speech provider.  The Reader
 * adapts its visible sections into a `ContinuousReadSource`, and reuses the
 * established passage TTS route for `play`.  Keeping the seam here prevents
 * this feature from reading a whole book into memory (or queueing a whole book
 * with speechSynthesis) before the first sentence has even finished.
 */
export interface ContinuousReadSentence {
  /** Stable while a book is open; normally a CFI range supplied by Foliate. */
  id: string;
  text: string;
  /** A BCP-47 language tag when the source document supplies one. */
  language?: string;
}

export interface ContinuousReadSource {
  first(fromBeginning?: boolean): Promise<ContinuousReadSentence | null>;
  next(after: ContinuousReadSentence): Promise<ContinuousReadSentence | null>;
  previous(before: ContinuousReadSentence): Promise<ContinuousReadSentence | null>;
  /** Turns the page/section only when this particular sentence becomes due. */
  reveal(sentence: ContinuousReadSentence): Promise<void>;
}

export interface ContinuousReadPlayer {
  /** Resolves only after the sentence ended naturally. */
  play(sentence: ContinuousReadSentence, rate: number): Promise<void>;
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
}

const INITIAL_STATE: ContinuousReadState = { status: "idle", current: null, rate: 1, collapsed: false };

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

  constructor(source: ContinuousReadSource, player: ContinuousReadPlayer) {
    this.source = source;
    this.player = player;
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

  private async playFrom(sentence: ContinuousReadSentence, token: number): Promise<void> {
    let current: ContinuousReadSentence | null = sentence;
    while (current && token === this.generation) {
      if (this.pauseRequested) {
        this.publish({ ...this.state, status: "paused", current });
        return;
      }
      this.publish({ ...this.state, status: "loading", current });
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
        try {
          await this.player.play(current, this.state.rate);
        } finally {
          this.playerActive = false;
        }
      } catch {
        if (token === this.generation) this.publish({ ...this.state, status: "error", current, collapsed: false });
        return;
      }
      if (token !== this.generation || this.pauseRequested) return;
      try {
        current = await this.source.next(current);
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
    this.publish({ ...this.state, status: "loading", current: null, collapsed: false });
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
    this.publish({ ...this.state, status: "idle", current: null, collapsed: false });
  }

  /** Mirrors the shared speech player's parked state without pausing a foreground word. */
  syncPlayerPaused(): void {
    if (this.state.status !== "playing" && this.state.status !== "loading") return;
    this.pauseRequested = true;
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
    this.publish({ ...this.state, status: "idle", current: null, collapsed: false });
  }

  async skip(direction: "previous" | "next"): Promise<void> {
    const current = this.state.current;
    if (!current) return this.start();
    const token = ++this.generation;
    this.pauseRequested = false;
    this.player.stop();
    this.publish({ ...this.state, status: "loading" });
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
    this.publish({ ...this.state, rate: Math.min(2, Math.max(0.5, rate)) });
  }

  setCollapsed(collapsed: boolean): void {
    this.publish({ ...this.state, collapsed });
  }
}
