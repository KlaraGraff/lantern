import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countBooks,
  deriveLibraryIndexRow,
  failedBookIds,
  isAlreadyRunning,
  notReadyStatus,
  overallFraction,
  runningBook,
  visibleChunkCount,
  type BatchBookStatus,
  type BatchIndexProgress,
} from "../src/components/settings/library-index.ts";

const book = (over: Partial<BatchBookStatus> & { bookId: string }): BatchBookStatus => ({
  title: over.bookId,
  state: "pending",
  ...over,
});

const batch = (over: Partial<BatchIndexProgress> = {}): BatchIndexProgress => ({
  state: "running",
  current: 0,
  total: 0,
  books: [],
  ...over,
});

describe("deriveLibraryIndexRow", () => {
  it("disables the row when no search model is configured", () => {
    assert.deepEqual(
      deriveLibraryIndexRow({ available: false, needs: { pending: 3, ready: 0 }, batch: null }),
      { kind: "unavailable" },
    );
  });

  it("offers the pending count once a search model is available", () => {
    assert.deepEqual(
      deriveLibraryIndexRow({ available: true, needs: { pending: 2, ready: 5 }, batch: null }),
      { kind: "idle", pending: 2 },
    );
  });

  it("treats a library with nothing to do as idle at zero", () => {
    assert.deepEqual(
      deriveLibraryIndexRow({ available: true, needs: { pending: 0, ready: 7 }, batch: null }),
      { kind: "idle", pending: 0 },
    );
    // Needs not fetched yet reads the same way: no count to offer.
    assert.deepEqual(
      deriveLibraryIndexRow({ available: true, needs: null, batch: null }),
      { kind: "idle", pending: 0 },
    );
  });

  it("shows a run in flight even if the model went unavailable underneath it", () => {
    const running = batch({
      current: 2,
      total: 2,
      books: [book({ bookId: "a", state: "done" }), book({ bookId: "b", state: "running" })],
    });
    const row = deriveLibraryIndexRow({ available: false, needs: null, batch: running });
    assert.equal(row.kind, "running");
    assert.deepEqual(row.kind === "running" ? [row.current, row.total] : null, [2, 2]);
  });

  it("keeps a finished run on screen only while it has failures to answer for", () => {
    const failed = batch({
      state: "done",
      current: 0,
      total: 2,
      books: [
        book({ bookId: "a", state: "done" }),
        book({ bookId: "b", state: "failed", message: "connection refused" }),
      ],
    });
    assert.deepEqual(deriveLibraryIndexRow({ available: true, needs: { pending: 1, ready: 1 }, batch: failed }), {
      kind: "finished",
      cancelled: false,
      done: 1,
      failed: 1,
      books: failed.books,
    });

    // Everything succeeded: the live count says more than the stale snapshot.
    const clean = batch({
      state: "done",
      current: 0,
      total: 1,
      books: [book({ bookId: "a", state: "done" })],
    });
    assert.deepEqual(deriveLibraryIndexRow({ available: true, needs: { pending: 0, ready: 1 }, batch: clean }), {
      kind: "idle",
      pending: 0,
    });
  });

  it("recovers a run that finished with failures while settings were closed", () => {
    // The exact reopen path: nothing was listening, so everything the row
    // draws has to come out of `ai_index_all_books_status`.
    const snapshot = batch({
      state: "done",
      current: 0,
      total: 3,
      books: [
        book({ bookId: "a", state: "done" }),
        book({ bookId: "b", state: "failed", message: "AI_INDEX_NOT_READY:missing" }),
        book({ bookId: "c", state: "failed", message: "connection refused" }),
      ],
    });
    const row = deriveLibraryIndexRow({ available: true, needs: { pending: 2, ready: 1 }, batch: snapshot });
    assert.equal(row.kind, "finished");
    assert.deepEqual(row.kind === "finished" ? [row.done, row.failed] : null, [1, 2]);
    assert.deepEqual(failedBookIds(snapshot), ["b", "c"]);
  });

  it("reports a stopped run that left failures as stopped, not merely done", () => {
    const stopped = batch({
      state: "cancelled",
      current: 0,
      total: 3,
      books: [
        book({ bookId: "a", state: "done" }),
        book({ bookId: "b", state: "failed", message: "boom" }),
        book({ bookId: "c", state: "pending" }),
      ],
    });
    const row = deriveLibraryIndexRow({ available: true, needs: { pending: 2, ready: 1 }, batch: stopped });
    assert.equal(row.kind === "finished" && row.cancelled, true);
  });

  it("falls back to the pending count when a stop left nothing broken", () => {
    const stopped = batch({
      state: "cancelled",
      current: 0,
      total: 2,
      books: [book({ bookId: "a", state: "done" }), book({ bookId: "b", state: "pending" })],
    });
    assert.deepEqual(deriveLibraryIndexRow({ available: true, needs: { pending: 1, ready: 1 }, batch: stopped }), {
      kind: "idle",
      pending: 1,
    });
  });
});

describe("failedBookIds", () => {
  it("names only the failures, in the run's own order", () => {
    const finished = batch({
      state: "done",
      total: 4,
      books: [
        book({ bookId: "a", state: "failed", message: "boom" }),
        book({ bookId: "b", state: "done" }),
        book({ bookId: "c", state: "pending" }),
        book({ bookId: "d", state: "failed", message: "boom" }),
      ],
    });
    assert.deepEqual(failedBookIds(finished), ["a", "d"]);
  });

  it("is empty rather than undefined when there is no run to read", () => {
    assert.deepEqual(failedBookIds(null), []);
  });
});

describe("countBooks", () => {
  it("counts every state, including the ones with no rows", () => {
    assert.deepEqual(
      countBooks([book({ bookId: "a", state: "done" }), book({ bookId: "b", state: "failed" })]),
      { pending: 0, running: 0, done: 1, failed: 1 },
    );
  });
});

describe("overallFraction", () => {
  it("carries finished books and adds the current book's own share", () => {
    // Two books, second in flight at 118/279 — the mockup's 72% bar.
    const fraction = overallFraction({ current: 2, total: 2 }, { done: 118, total: 279 });
    assert.ok(fraction !== null && Math.abs(fraction - 0.7115) < 0.001);
  });

  it("returns null before anything has moved, so the bar sweeps", () => {
    assert.equal(overallFraction({ current: 0, total: 2 }, null), null);
    // One book, an uncountable phase: nothing finished and nothing to count.
    assert.equal(overallFraction({ current: 1, total: 1 }, null), null);
    assert.equal(overallFraction({ current: 1, total: 1 }, { done: 0, total: 0 }), null);
  });

  it("still moves per book when the phase in flight cannot count", () => {
    assert.equal(overallFraction({ current: 2, total: 4 }, null), 0.25);
  });

  it("never exceeds one, whatever the counters claim", () => {
    assert.equal(overallFraction({ current: 3, total: 2 }, { done: 500, total: 100 }), 1);
  });

  it("has nothing to draw for an empty run", () => {
    assert.equal(overallFraction({ current: 0, total: 0 }, null), null);
  });
});

describe("runningBook", () => {
  it("finds the book in flight and nothing when between books", () => {
    const running = batch({
      current: 2,
      total: 2,
      books: [book({ bookId: "a", state: "done" }), book({ bookId: "b", state: "running" })],
    });
    assert.equal(runningBook(running)?.bookId, "b");
    assert.equal(runningBook(batch({ books: [book({ bookId: "a" })] })), null);
    assert.equal(runningBook(null), null);
  });
});

describe("notReadyStatus", () => {
  it("pulls the status out of the marker the backend uses", () => {
    assert.equal(notReadyStatus("AI_INDEX_NOT_READY:missing"), "missing");
    assert.equal(notReadyStatus("AI_INDEX_NOT_READY:unsupported"), "unsupported");
  });

  it("leaves a provider's own error alone", () => {
    assert.equal(notReadyStatus("connection refused"), null);
    assert.equal(notReadyStatus(undefined), null);
    assert.equal(notReadyStatus("AI_INDEX_NOT_READY:"), null);
  });
});

describe("visibleChunkCount", () => {
  it("shows the count the payload carries for a finished book", () => {
    assert.equal(visibleChunkCount(book({ bookId: "a", state: "done", chunkCount: 1204 })), 1204);
    // The whole point: the outlier is a number like any other, so it can only
    // be spotted against its neighbours — which means it must not be hidden
    // for being small.
    assert.equal(visibleChunkCount(book({ bookId: "b", state: "done", chunkCount: 12 })), 12);
  });

  it("stays quiet on every row that is not finished", () => {
    for (const state of ["pending", "running", "failed"] as const) {
      assert.equal(visibleChunkCount(book({ bookId: "a", state, chunkCount: 900 })), null, state);
    }
  });

  it("stays quiet when the backend sent no count, and when it sent zero", () => {
    assert.equal(visibleChunkCount(book({ bookId: "a", state: "done" })), null);
    assert.equal(visibleChunkCount(book({ bookId: "a", state: "done", chunkCount: 0 })), null);
  });
});

describe("isAlreadyRunning", () => {
  it("recognises the second-press error however Tauri wrapped it", () => {
    assert.equal(isAlreadyRunning("AI_INDEX_BATCH_ALREADY_RUNNING"), true);
    assert.equal(isAlreadyRunning(new Error("Other: AI_INDEX_BATCH_ALREADY_RUNNING")), true);
    assert.equal(isAlreadyRunning("connection refused"), false);
  });
});
