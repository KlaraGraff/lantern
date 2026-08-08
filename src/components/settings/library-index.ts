/**
 * What the whole-library index row in AI settings needs to know about a batch
 * run, kept free of React and Tauri so it can be reasoned about (and tested)
 * on its own.
 *
 * The shapes here mirror the batch half of
 * `src-tauri/src/commands/ai/book_index.rs`.
 */

import type { IndexRunState } from "../index-state";

export type BatchBookState = "pending" | "running" | "done" | "failed";

/** One row of the batch's book list. */
export interface BatchBookStatus {
  bookId: string;
  title: string;
  state: BatchBookState;
  /** Absent unless `failed`, and untranslated — a provider's own wording. */
  message?: string;
  /** Absent unless `done` — see `visibleChunkCount`. */
  chunkCount?: number;
}

/**
 * One event on `ai-index-all-progress`, and equally what
 * `ai_index_all_books_status` hands back on mount.
 *
 * `state` reuses the per-book run state so a listener switches on the same
 * strings at both levels; `"failed"` never actually arrives here, because one
 * book failing is a row on that book rather than an end to the run.
 */
export interface BatchIndexProgress {
  state: IndexRunState;
  /** 1-based position of the book in flight, or `0` when none is. */
  current: number;
  total: number;
  books: BatchBookStatus[];
}

/** What `ai_books_needing_index` reports. */
export interface LibraryIndexNeeds {
  pending: number;
  ready: number;
}

/**
 * The one state the row renders from.
 *
 * `finished` is deliberately reserved for a run that left failures behind. A
 * run where everything succeeded has nothing left to say that the `idle`
 * count does not say better — and the count is the live truth, whereas the
 * retained snapshot only describes one past run.
 */
export type LibraryIndexRow =
  | { kind: "unavailable" }
  | { kind: "idle"; pending: number }
  | { kind: "running"; current: number; total: number; books: BatchBookStatus[] }
  | { kind: "finished"; cancelled: boolean; done: number; failed: number; books: BatchBookStatus[] };

export function batchIsRunning(batch: BatchIndexProgress | null): boolean {
  return batch?.state === "running";
}

export function countBooks(books: BatchBookStatus[]): Record<BatchBookState, number> {
  const counts: Record<BatchBookState, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const book of books) counts[book.state] += 1;
  return counts;
}

/**
 * The ids a "retry the failed ones" press submits back through
 * `ai_index_all_books`: exactly the rows the terminal payload marked `failed`,
 * in the order the run took them.
 *
 * Books the run never reached are `pending`, not `failed`, and are left out on
 * purpose — they are still in the library-wide count, so the ordinary
 * "index N books" press picks them up, and folding them in here would make one
 * button quietly mean two different things.
 */
export function failedBookIds(batch: BatchIndexProgress | null): string[] {
  return (batch?.books ?? []).filter((book) => book.state === "failed").map((book) => book.bookId);
}

/**
 * Which of the row's states to draw.
 *
 * A run in flight outranks everything, including a search model that has since
 * gone unavailable: telling the reader the feature is unconfigured while their
 * books are visibly being indexed would be the more confusing lie.
 */
export function deriveLibraryIndexRow(input: {
  available: boolean;
  needs: LibraryIndexNeeds | null;
  batch: BatchIndexProgress | null;
}): LibraryIndexRow {
  const { available, needs, batch } = input;
  if (batchIsRunning(batch) && batch) {
    return { kind: "running", current: batch.current, total: batch.total, books: batch.books };
  }
  if (!available) return { kind: "unavailable" };
  if (batch) {
    const counts = countBooks(batch.books);
    if (counts.failed > 0) {
      return {
        kind: "finished",
        cancelled: batch.state === "cancelled",
        done: counts.done,
        failed: counts.failed,
        books: batch.books,
      };
    }
  }
  return { kind: "idle", pending: needs?.pending ?? 0 };
}

/**
 * How far along the run is, as a fraction, or `null` when there is nothing
 * honest to draw yet — which must render as an indeterminate sweep rather than
 * a 0% bar sitting still.
 *
 * Books already finished carry the bar; the book in flight contributes its own
 * fraction of one book's width, so a single large book still moves something.
 */
export function overallFraction(
  batch: Pick<BatchIndexProgress, "current" | "total">,
  inner: { done: number; total: number } | null,
): number | null {
  if (batch.total <= 0) return null;
  const finished = Math.max(0, Math.min(batch.current - 1, batch.total));
  const within = inner && inner.total > 0 ? Math.min(1, Math.max(0, inner.done / inner.total)) : 0;
  const fraction = Math.min(1, (finished + within) / batch.total);
  return fraction > 0 ? fraction : null;
}

/**
 * The chunk count to put on a row, or `null` for a row that must stay quiet.
 *
 * Only finished books. The number is here to be compared down the column —
 * `ensure_index` calls any non-empty extraction a success, so the book whose
 * parser produced twelve chunks looks exactly as done as the one that produced
 * two thousand until the counts sit side by side. That comparison only works
 * between books that finished; a count on a waiting or failed row would be a
 * number with nothing to mean, and forty rows of digits where the reader is
 * meant to spot one.
 *
 * `0` is filtered out with the rest: a finished book with no chunks is a
 * contradiction the batch reports as a failure long before this, so a zero
 * here would only ever be a missing value wearing a number.
 */
export function visibleChunkCount(book: BatchBookStatus): number | null {
  if (book.state !== "done") return null;
  return typeof book.chunkCount === "number" && book.chunkCount > 0 ? book.chunkCount : null;
}

/** The book the run is working on, or `null` between books. */
export function runningBook(batch: BatchIndexProgress | null): BatchBookStatus | null {
  return (batch?.books ?? []).find((book) => book.state === "running") ?? null;
}

const NOT_READY_PREFIX = "AI_INDEX_NOT_READY:";

/**
 * `AI_INDEX_NOT_READY:<status>` means the run ended cleanly but left no usable
 * index — a missing file, or a book with no extractable text. Those have
 * readable copy; anything else is a provider's own error string, which does
 * not belong on a settings row.
 */
export function notReadyStatus(message: string | undefined): string | null {
  if (!message?.startsWith(NOT_READY_PREFIX)) return null;
  const status = message.slice(NOT_READY_PREFIX.length).trim();
  return status.length > 0 ? status : null;
}

export const BATCH_ALREADY_RUNNING = "AI_INDEX_BATCH_ALREADY_RUNNING";

export function isAlreadyRunning(error: unknown): boolean {
  return String(error).includes(BATCH_ALREADY_RUNNING);
}
