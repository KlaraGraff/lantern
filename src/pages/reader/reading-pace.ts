/**
 * Purely local reading-speed estimator (P1.5): a sliding window over the
 * elapsed time between consecutive *ordinary* page turns, used to project
 * "minutes left in this chapter" and "time left in the book". No telemetry,
 * no backend — every sample lives only in memory for the current reading
 * session and resets on every book switch.
 */

/** One position snapshot, taken on every relocate. */
export interface PageTurnSnapshot {
  /** Raw Foliate section index the reader is currently in. */
  sectionIndex: number;
  /** Current page within that section (`pageInfo.current`, or the leading
   * page of a two-column spread). */
  page: number;
  /** Whole-book progress, 0-100. */
  progress: number;
  /** `Date.now()` at the moment this snapshot was taken. */
  timestampMs: number;
}

export interface PaceSample {
  elapsedMs: number;
  /** How many pages advanced (1 for a single page, 2 for a two-column spread turn). */
  pageDelta: number;
  /** How many whole-book percentage points were covered by this turn. */
  percentDelta: number;
}

/** Samples kept in the sliding window. Small enough that a change in pace
 * (skimming, then settling into slow reading) shows up within a few turns. */
export const PACE_WINDOW_SIZE = 8;

/**
 * Elapsed time above this is treated as the app having sat idle — closed on a
 * desk overnight, a long interruption — rather than continuous reading, and
 * the sample is dropped instead of poisoning the average with an outlier.
 */
export const PACE_MAX_ELAPSED_MS = 5 * 60 * 1000;

/** Guards against near-zero-duration duplicate relocate events. */
export const PACE_MIN_ELAPSED_MS = 250;

/** A turn that advances more than this many pages is a jump (TOC, scrubber,
 * search), not an ordinary page turn — two pages covers a two-column spread. */
export const PACE_MAX_PAGE_ADVANCE = 2;

/** Below this many qualifying samples, an estimate would be noise — the
 * caller should show "calculating…" instead of a number. */
export const PACE_MIN_SAMPLES = 3;

/**
 * Turns a page-turn transition into a pace sample, or `null` when it doesn't
 * qualify: a chapter change, a multi-page jump, a backward turn, or an
 * implausible elapsed time (idle, or a duplicate event) all fall outside what
 * a sliding-window pace average should absorb.
 */
export function derivePaceSample(
  previous: PageTurnSnapshot | null,
  next: PageTurnSnapshot,
): PaceSample | null {
  if (!previous) return null;
  if (next.sectionIndex !== previous.sectionIndex) return null;

  const pageDelta = next.page - previous.page;
  if (pageDelta < 1 || pageDelta > PACE_MAX_PAGE_ADVANCE) return null;

  const elapsedMs = next.timestampMs - previous.timestampMs;
  if (elapsedMs < PACE_MIN_ELAPSED_MS || elapsedMs > PACE_MAX_ELAPSED_MS) return null;

  const percentDelta = next.progress - previous.progress;
  if (percentDelta <= 0) return null;

  return { elapsedMs, pageDelta, percentDelta };
}

/** Appends a sample, keeping only the most recent `PACE_WINDOW_SIZE`. */
export function pushPaceSample(
  window: readonly PaceSample[],
  sample: PaceSample,
): PaceSample[] {
  const next = [...window, sample];
  return next.length > PACE_WINDOW_SIZE ? next.slice(next.length - PACE_WINDOW_SIZE) : next;
}

/**
 * Average seconds per page across the window. Aggregates total time over
 * total pages rather than averaging per-sample ratios, so a two-column spread
 * turn doesn't get the same weight as a single-page one.
 */
export function averageSecondsPerPage(window: readonly PaceSample[]): number | null {
  if (window.length < PACE_MIN_SAMPLES) return null;
  const totalSeconds = window.reduce((sum, sample) => sum + sample.elapsedMs / 1000, 0);
  const totalPages = window.reduce((sum, sample) => sum + sample.pageDelta, 0);
  return totalPages > 0 ? totalSeconds / totalPages : null;
}

/** Average seconds per whole-book percentage point across the window. */
export function averageSecondsPerPercent(window: readonly PaceSample[]): number | null {
  if (window.length < PACE_MIN_SAMPLES) return null;
  const totalSeconds = window.reduce((sum, sample) => sum + sample.elapsedMs / 1000, 0);
  const totalPercent = window.reduce((sum, sample) => sum + sample.percentDelta, 0);
  return totalPercent > 0 ? totalSeconds / totalPercent : null;
}

/** `null` when there isn't yet a usable estimate — the caller shows "calculating…". */
export function minutesLeftInChapter(
  secondsPerPage: number | null,
  pagesLeft: number,
): number | null {
  if (secondsPerPage === null) return null;
  return Math.max(0, Math.round((Math.max(0, pagesLeft) * secondsPerPage) / 60));
}

/** `null` when there isn't yet a usable estimate — the caller shows "calculating…". */
export function minutesLeftInBook(
  secondsPerPercent: number | null,
  percentLeft: number,
): number | null {
  if (secondsPerPercent === null) return null;
  return Math.max(0, Math.round((Math.max(0, percentLeft) * secondsPerPercent) / 60));
}
