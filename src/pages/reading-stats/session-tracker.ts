export const READING_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const READING_SESSION_HEARTBEAT_MS = 15 * 1000;
export const READING_SESSION_CHECKPOINT_MS = 60 * 1000;

export interface ReadingSessionInput {
  bookId: string;
  startedAt: number;
  endedAt: number;
  activeSeconds: number;
  checkpointKey?: string;
}

export interface ReadingSessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReadingSessionTrackerOptions {
  clock: ReadingSessionClock;
  record(input: ReadingSessionInput): Promise<unknown>;
  idleTimeoutMs?: number;
}

interface ActiveSegment {
  bookId: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  activeMs: number;
  checkpointKey: string;
  checkpointedActiveMs: number;
}

function toInput(segment: ActiveSegment, endedAtMs: number): ReadingSessionInput {
  const startedAt = Math.floor(segment.startedAtMs);
  const endedAt = Math.max(startedAt, Math.floor(endedAtMs));
  return {
    bookId: segment.bookId,
    startedAt,
    endedAt,
    activeSeconds: Math.min(Math.floor((endedAt - startedAt) / 1000), Math.floor(segment.activeMs / 1000)),
    checkpointKey: segment.checkpointKey,
  };
}

/**
 * Tracks only foreground reading activity. The backend remains authoritative
 * for discarding segments shorter than 30 seconds.
 */
export class ReadingSessionTracker {
  private readonly clock: ReadingSessionClock;
  private record: ReadingSessionTrackerOptions["record"];
  private readonly idleTimeoutMs: number;
  private bookId: string | null = null;
  private segment: ActiveSegment | null = null;
  private idleTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private foreground = true;

  constructor(options: ReadingSessionTrackerOptions) {
    this.clock = options.clock;
    this.record = options.record;
    this.idleTimeoutMs = options.idleTimeoutMs ?? READING_IDLE_TIMEOUT_MS;
  }

  setRecord(record: ReadingSessionTrackerOptions["record"]): void {
    this.record = record;
  }

  setBook(bookId: string | null): void {
    if (bookId === this.bookId) return;
    this.finish(this.clock.now(), true);
    this.bookId = bookId;
  }

  activity(): void {
    if (!this.bookId || !this.foreground) return;
    const now = this.clock.now();
    if (!this.segment) {
      this.segment = {
        bookId: this.bookId,
        startedAtMs: now,
        lastActivityAtMs: now,
        activeMs: 0,
        checkpointKey: `${this.bookId.slice(0, 200)}:${now}`,
        checkpointedActiveMs: 0,
      };
    } else {
      const gap = now - this.segment.lastActivityAtMs;
      if (gap < 0 || gap >= this.idleTimeoutMs) {
        this.finish(this.segment.lastActivityAtMs, false);
        this.segment = {
          bookId: this.bookId,
          startedAtMs: now,
          lastActivityAtMs: now,
          activeMs: 0,
          checkpointKey: `${this.bookId.slice(0, 200)}:${now}`,
          checkpointedActiveMs: 0,
        };
      } else {
        this.segment.activeMs += gap;
        this.segment.lastActivityAtMs = now;
        this.checkpoint();
      }
    }
    this.armIdleTimer();
  }

  heartbeat(): void {
    if (!this.segment) return;
    const now = this.clock.now();
    const gap = now - this.segment.lastActivityAtMs;
    if (gap < 0 || gap >= this.idleTimeoutMs) {
      // A large clock jump usually means sleep/wake. End at the last observed
      // activity so suspended time is never invented as reading time.
      this.finish(this.segment.lastActivityAtMs, false);
    }
  }

  blur(): void {
    this.foreground = false;
    this.finish(this.clock.now(), true);
  }

  focus(): void {
    this.foreground = true;
  }

  visibilityChange(hidden: boolean): void {
    if (hidden) this.blur();
    else this.focus();
  }

  pageHide(): void {
    this.finish(this.clock.now(), true);
  }

  stop(): Promise<void> {
    this.finish(this.clock.now(), true);
    return this.queue;
  }

  whenIdle(): Promise<void> {
    return this.queue;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      if (!this.segment) return;
      this.finish(this.segment.lastActivityAtMs, false);
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private checkpoint(): void {
    const segment = this.segment;
    if (!segment || segment.activeMs - segment.checkpointedActiveMs < READING_SESSION_CHECKPOINT_MS) return;
    segment.checkpointedActiveMs = segment.activeMs;
    const input = toInput(segment, segment.lastActivityAtMs);
    this.enqueue(input);
  }

  private enqueue(input: ReadingSessionInput): void {
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.record(input))
      .then(() => undefined)
      .catch(() => undefined);
  }

  private finish(now: number, includeForegroundTail: boolean): void {
    const segment = this.segment;
    if (!segment) return;
    this.clearIdleTimer();
    this.segment = null;

    const tail = now - segment.lastActivityAtMs;
    if (includeForegroundTail && tail > 0 && tail < this.idleTimeoutMs) {
      segment.activeMs += tail;
    }
    const endedAtMs = includeForegroundTail && tail >= 0 && tail < this.idleTimeoutMs
      ? now
      : segment.lastActivityAtMs;
    const input = toInput(segment, endedAtMs);
    // A single transient backend failure must not poison the serialized queue:
    // later sessions still need a chance to persist when the reader regains
    // connectivity or the database becomes available again.
    this.enqueue(input);
  }
}

export const browserReadingSessionClock: ReadingSessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};
