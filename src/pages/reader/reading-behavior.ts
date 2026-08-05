// Pure, framework-free collection logic for
// docs/impls/reading-driven-mastery-and-review.md. Nothing here computes a
// mastery score or a display weight — this only turns raw reader signals
// (the visible text on a settled screen, plus operation/lookup events)
// into the batches that `record_reading_behavior_batch` persists. See
// src-tauri/migrations/037_reading_behavior.sql for the storage side and
// its per-field design-doc citations.
//
// Modeled closely on ../reading-stats/session-tracker.ts: an injectable
// clock for testability, a serialized flush queue that swallows write
// failures so a flaky backend never blocks later screens, and a plain
// class wrapped by a thin React hook (useReadingBehaviorTracking.ts).

const WORD_TOKEN_RE = /[\p{L}\p{N}']+/gu;
const EDGE_TRIM_RE = /^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu;
const HAS_LETTER_RE = /\p{L}/u;

const MAX_WORD_LEN = 64;
const MAX_WORDS_PER_SCREEN = 800;
const MAX_LOOKED_UP_WORDS_PER_SCREEN = 50;

// A reader who never looked up a stopword shouldn't get 40% of a chapter's
// "encounter_count" rows spent on "the"/"and"/"of" — filtered here so the
// per-word exposure table (see the migration) stays a vocabulary table, not
// a function-word frequency table. This is a scope decision beyond the
// letter of the brief; swapping or dropping this list later does not
// change the schema or the backend.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at",
  "by", "for", "with", "from", "as", "is", "was", "were", "be", "been",
  "being", "am", "are", "this", "that", "these", "those", "it", "its",
  "he", "she", "they", "we", "you", "i", "my", "your", "his", "her",
  "their", "our", "me", "him", "them", "us", "do", "does", "did", "have",
  "has", "had", "not", "no", "nor", "so", "than", "then", "there", "here",
  "when", "where", "who", "whom", "which", "what", "why", "how", "all",
  "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "only", "own", "same", "too", "very", "can", "will", "just", "should",
  "now", "up", "down", "out", "off", "over", "under", "again", "further",
  "once", "s", "t", "don", "ll", "re", "ve", "d", "m", "o", "y", "ain",
  "aren", "couldn", "didn", "doesn", "hadn", "hasn", "haven", "isn", "ma",
  "mightn", "mustn", "needn", "shan", "shouldn", "wasn", "weren", "won",
  "wouldn", "let", "into", "about", "above", "below", "between", "through",
  "during", "before", "after", "while", "because", "until", "against",
  "yes", "ok", "okay",
]);

/** Mirrors `normalize()` in src-tauri/src/commands/lookup_history.rs so
 * exposure records join cleanly against `lookup_records.normalized_text`. */
export function normalizeWord(raw: string): string {
  return raw.replace(EDGE_TRIM_RE, "").toLowerCase();
}

export interface TokenizedScreen {
  /** All word-like tokens, not deduped, stopwords included — the pace
   * numerator (§5.1 of the design doc). */
  rawTokenCount: number;
  /** Deduped, normalized, stopword-filtered content words — the vocabulary
   * exposure signal (§2.1/§2.2/§9.2). Capped defensively so one dense
   * screen can never make a whole batch item fail backend validation. */
  contentWords: string[];
}

export function tokenizeVisibleText(text: string): TokenizedScreen {
  const matches = text.match(WORD_TOKEN_RE) ?? [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const normalized = normalizeWord(raw);
    if (!normalized || normalized.length > MAX_WORD_LEN) continue;
    if (!HAS_LETTER_RE.test(normalized)) continue; // drop page numbers etc.
    if (STOPWORDS.has(normalized)) continue;
    seen.add(normalized);
    if (seen.size >= MAX_WORDS_PER_SCREEN) break;
  }
  return { rawTokenCount: matches.length, contentWords: Array.from(seen) };
}

export type ReadingOperationKind = "selection" | "lookup" | "annotation" | "bookmark";

export interface FinalizedScreen {
  bookId: string;
  chapter: string | null;
  cfi: string | null;
  startedAt: number;
  endedAt: number;
  operationCount: number;
  lookupCount: number;
  wordCount: number;
  words: string[];
  lookedUpWords: string[];
}

export interface ScreenExposureClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ScreenExposureTrackerOptions {
  clock: ScreenExposureClock;
  flush(screens: FinalizedScreen[]): Promise<unknown>;
  /** How long a viewport position must stop changing before it counts as a
   * settled "screen". Debounces continuous-scroll relocate bursts so one
   * scroll gesture doesn't register a dozen near-zero-dwell screens. */
  settleDelayMs?: number;
  /** How long to wait after a screen finalizes before flushing, so rapid
   * page-flipping coalesces into one write instead of many. */
  flushDelayMs?: number;
  /** Safety valve: force a flush once this many screens are waiting, so a
   * slow or failing backend can't grow this array without bound. */
  maxPendingScreens?: number;
}

interface PendingRelocate {
  chapter: string | null;
  cfi: string | null;
  visibleText: string;
  atMs: number;
}

interface ActiveScreen {
  bookId: string;
  chapter: string | null;
  cfi: string | null;
  startedAtMs: number;
  operationCount: number;
  lookupCount: number;
  wordCount: number;
  words: Set<string>;
  lookedUpWords: Set<string>;
}

const DEFAULT_SETTLE_DELAY_MS = 400;
const DEFAULT_FLUSH_DELAY_MS = 1500;
const DEFAULT_MAX_PENDING_SCREENS = 20;

/**
 * Turns raw `relocate` events and operation signals into finalized,
 * per-screen records, batched in memory and flushed only at natural
 * boundaries (screen settle debounce elapses, then a further flush
 * debounce) or immediately via `forceFlush` (page turn already implies a
 * new relocate — see `noteRelocate` — so the explicit force points are
 * book switch, reader close, and window blur/hidden).
 */
export class ScreenExposureTracker {
  private readonly clock: ScreenExposureClock;
  private flushFn: ScreenExposureTrackerOptions["flush"];
  private readonly settleDelayMs: number;
  private readonly flushDelayMs: number;
  private readonly maxPendingScreens: number;

  private bookId: string | null = null;
  private pendingRelocate: PendingRelocate | null = null;
  private settleTimer: unknown = null;
  private currentScreen: ActiveScreen | null = null;
  private pendingFlush: FinalizedScreen[] = [];
  private flushTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ScreenExposureTrackerOptions) {
    this.clock = options.clock;
    this.flushFn = options.flush;
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxPendingScreens = options.maxPendingScreens ?? DEFAULT_MAX_PENDING_SCREENS;
  }

  setFlush(flush: ScreenExposureTrackerOptions["flush"]): void {
    this.flushFn = flush;
  }

  /** A book switch is an unambiguous boundary: close out whatever was
   * being read, flush it, and start clean for the new book. */
  setBook(bookId: string | null): void {
    if (bookId === this.bookId) return;
    this.forceFlush();
    this.bookId = bookId;
  }

  /** Called on every `relocate` event, cheaply — this only stores the
   * already-computed visible text (see useFoliateView's existing
   * `viewRef.current?.lastLocation?.range`) and resets a debounce; the
   * actual tokenization work happens once, in `settle()`. */
  noteRelocate(input: { chapter: string | null; cfi: string | null; visibleText: string }): void {
    if (!this.bookId) return;
    const now = this.clock.now();
    this.pendingRelocate = { ...input, atMs: now };
    this.clearSettleTimer();
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = null;
      this.settle();
    }, this.settleDelayMs);
  }

  /** Any in-place operation (selection, lookup, annotation, bookmark) that
   * should count as evidence the reader is actually engaged with the
   * currently-settled screen, per §2.4's exclusion rule. Page turns and
   * scrolling are not passed here — both already arrive as `relocate`
   * events, which is what defines a screen boundary in the first place. */
  recordOperation(kind: ReadingOperationKind, normalizedWord?: string): void {
    const screen = this.currentScreen;
    if (!screen) return;
    screen.operationCount += 1;
    if (kind === "lookup") {
      screen.lookupCount += 1;
      if (normalizedWord && screen.lookedUpWords.size < MAX_LOOKED_UP_WORDS_PER_SCREEN) {
        screen.lookedUpWords.add(normalizedWord);
      }
    }
  }

  /** Reader close / window blur / visibility hidden: settle whatever
   * position is currently pending, close out the active screen, and flush
   * immediately rather than waiting on either debounce. */
  forceFlush(): void {
    this.clearSettleTimer();
    if (this.pendingRelocate) this.settle();
    this.finalizeCurrentScreen(this.clock.now());
    this.flushNow();
  }

  /** Mirrors ReadingSessionTracker.stop(): force a flush and return the
   * serialized write queue so callers can await it during teardown. */
  stop(): Promise<void> {
    this.forceFlush();
    return this.queue;
  }

  private settle(): void {
    const pending = this.pendingRelocate;
    if (!pending || !this.bookId) return;
    this.pendingRelocate = null;
    this.finalizeCurrentScreen(pending.atMs);
    const { rawTokenCount, contentWords } = tokenizeVisibleText(pending.visibleText);
    this.currentScreen = {
      bookId: this.bookId,
      chapter: pending.chapter,
      cfi: pending.cfi,
      startedAtMs: pending.atMs,
      operationCount: 0,
      lookupCount: 0,
      wordCount: rawTokenCount,
      words: new Set(contentWords),
      lookedUpWords: new Set(),
    };
  }

  private finalizeCurrentScreen(endedAtMs: number): void {
    const screen = this.currentScreen;
    if (!screen) return;
    this.currentScreen = null;
    const startedAt = Math.floor(screen.startedAtMs);
    const endedAt = Math.max(startedAt, Math.floor(endedAtMs));
    this.pendingFlush.push({
      bookId: screen.bookId,
      chapter: screen.chapter,
      cfi: screen.cfi,
      startedAt,
      endedAt,
      operationCount: screen.operationCount,
      lookupCount: screen.lookupCount,
      wordCount: screen.wordCount,
      words: Array.from(screen.words),
      lookedUpWords: Array.from(screen.lookedUpWords),
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush.length >= this.maxPendingScreens) {
      this.flushNow();
      return;
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.flushDelayMs);
  }

  private flushNow(): void {
    this.clearFlushTimer();
    if (this.pendingFlush.length === 0) return;
    const batch = this.pendingFlush;
    this.pendingFlush = [];
    // Serialized and failure-swallowing, like ReadingSessionTracker.enqueue:
    // a write failure must never surface to the reader, and must never
    // block a later, unrelated batch from trying.
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.flushFn(batch))
      .then(() => undefined)
      .catch(() => undefined);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

export const browserScreenExposureClock: ScreenExposureClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};
