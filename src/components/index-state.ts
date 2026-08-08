/**
 * What the index manager and the book context menu both need to know about a
 * book's index, kept free of React and Tauri so it can be reasoned about (and
 * tested) on its own.
 *
 * The shapes here mirror `src-tauri/src/commands/ai/book_index.rs`.
 */

/**
 * One stage of an index run. Five are listed even though the backend
 * currently folds aliases into `summarize`: the trail is sliced to the step
 * count the event reports, so the fifth name appears the moment the backend
 * starts reporting five steps and never a moment before.
 */
export type IndexPhase = "chunk" | "context" | "embed" | "summarize" | "aliases";

export type IndexRunState = "running" | "done" | "failed" | "cancelled";

/** One event on `ai-index-progress-{bookId}`. */
export interface IndexProgress {
  state: IndexRunState;
  /** On a terminal event, the phase the run ended in. */
  phase: IndexPhase;
  step: number;
  totalSteps: number;
  done: number;
  /** `0` when the phase cannot count its work in advance — see `visibleCounters`. */
  total: number;
  result?: { reindexed: boolean; embeddingsUpdated: boolean; summariesUpdated: boolean };
  /** Only on `failed`, and untranslated: a provider's own wording. */
  message?: string;
}

/** One event on the pre-existing `ai-summary-progress-{bookId}` channel. */
export interface SummaryCounters {
  done: number;
  total: number;
  phase: string;
}

export const INDEX_PHASES: IndexPhase[] = ["chunk", "context", "embed", "summarize", "aliases"];

/**
 * What the index manager is looking at, once the run's own state and the
 * window's "I just pressed the button" are reconciled.
 *
 * `"stopped"` is kept apart from `"failed"` deliberately, and it is the whole
 * reason this is a function rather than three inline comparisons: the reader
 * pressed stop, so there is nothing to apologise for and nothing to report as
 * an error — the run simply is not running any more, and the primary button
 * has to be reachable again, because pressing it is how they resume.
 *
 * `"settled"` covers both "nothing has run in this window" and "the last run
 * finished cleanly"; neither needs anything said about it beyond what the
 * stats and the verdict line already say.
 */
export type IndexRunOutcome = "running" | "stopped" | "failed" | "settled";

export function runOutcome(running: boolean, progress: IndexProgress | null): IndexRunOutcome {
  // `running` leads, because it is also true in the gap between pressing the
  // button and the first event arriving, when `progress` is still the previous
  // run's terminal event or nothing at all.
  if (running) return "running";
  if (progress?.state === "cancelled") return "stopped";
  if (progress?.state === "failed") return "failed";
  return "settled";
}

export interface IndexSummary {
  sectionIndex?: number | null;
  sectionTitle?: string | null;
  content: string;
  userEdited: boolean;
}

export interface IndexDetails {
  status: "ready" | "building" | "failed" | "unsupported" | "missing";
  error?: string | null;
  chunkCount: number;
  embeddedCount: number;
  embeddingModel?: string | null;
  indexedAt?: number | null;
  overview?: IndexSummary | null;
  sections: IndexSummary[];
  chunks: Array<{ index: number; sectionTitle?: string | null; snippet: string }>;
}

/**
 * The single fact the verdict line and the menu suffix are both built from.
 *
 * `partial` is the state the backend has no name for and the reason this
 * whole surface was reworked: the chunks are there, so `status` says `ready`,
 * but without vectors the book only answers keyword searches. Four stat cards
 * never made that legible.
 */
export type BookIndexState = "unsupported" | "failed" | "building" | "none" | "partial" | "ready";

export function deriveBookIndexState(
  details: Pick<IndexDetails, "status" | "chunkCount" | "embeddedCount">,
): BookIndexState {
  switch (details.status) {
    case "unsupported":
      return "unsupported";
    case "failed":
      return "failed";
    case "building":
      return "building";
    case "missing":
      return "none";
    default:
      break;
  }
  if (details.chunkCount <= 0) return "none";
  return details.embeddedCount >= details.chunkCount ? "ready" : "partial";
}

/**
 * The phases to draw as a trail, cut to the number of steps the run says it
 * has. Clamped rather than trusted: a step count outside the list would
 * otherwise render an empty trail or drop the phase in flight.
 */
export function phaseTrail(totalSteps: number): IndexPhase[] {
  const count = Math.min(Math.max(Math.trunc(totalSteps) || 0, 1), INDEX_PHASES.length);
  return INDEX_PHASES.slice(0, count);
}

/**
 * The numbers to draw for the phase in flight, or `null` when the phase
 * cannot count — which must render as an indeterminate stage, never as a 0%
 * bar sitting still.
 *
 * `summarize` reports `0` on the index channel and keeps its real counters on
 * `ai-summary-progress-{bookId}`. Borrowing them here is the one place the two
 * channels meet, and only when the index channel has said it has nothing —
 * so the same work is never counted twice.
 */
export function visibleCounters(
  progress: Pick<IndexProgress, "phase" | "done" | "total">,
  summary: SummaryCounters | null,
): { done: number; total: number } | null {
  if (progress.total > 0) return { done: progress.done, total: progress.total };
  if (progress.phase === "summarize" && summary && summary.total > 0) {
    return { done: summary.done, total: summary.total };
  }
  return null;
}
