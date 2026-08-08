import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveBookIndexState,
  phaseTrail,
  runOutcome,
  visibleCounters,
  type IndexDetails,
  type IndexProgress,
} from "../src/components/index-state.ts";

type Reading = Pick<IndexDetails, "status" | "chunkCount" | "embeddedCount">;

const reading = (over: Partial<Reading> = {}): Reading => ({
  status: "ready",
  chunkCount: 642,
  embeddedCount: 642,
  ...over,
});

describe("deriveBookIndexState", () => {
  it("calls a chunked book with no vectors partial, not ready", () => {
    // The whole point of the verdict line: the backend's own status says
    // "ready" here, because chunking is all it tracks.
    assert.equal(deriveBookIndexState(reading({ embeddedCount: 0 })), "partial");
    assert.equal(deriveBookIndexState(reading({ embeddedCount: 641 })), "partial");
  });

  it("calls a fully embedded book ready", () => {
    assert.equal(deriveBookIndexState(reading()), "ready");
  });

  it("treats a ready status with no chunks as nothing built", () => {
    assert.equal(deriveBookIndexState(reading({ chunkCount: 0, embeddedCount: 0 })), "none");
    assert.equal(deriveBookIndexState(reading({ status: "missing" })), "none");
  });

  it("passes the backend's own terminal states straight through", () => {
    assert.equal(deriveBookIndexState(reading({ status: "unsupported" })), "unsupported");
    assert.equal(deriveBookIndexState(reading({ status: "failed" })), "failed");
    assert.equal(deriveBookIndexState(reading({ status: "building" })), "building");
  });
});

describe("phaseTrail", () => {
  it("shows exactly the steps the run says it has", () => {
    assert.deepEqual(phaseTrail(4), ["chunk", "context", "embed", "summarize"]);
    assert.deepEqual(phaseTrail(5), ["chunk", "context", "embed", "summarize", "aliases"]);
  });

  it("clamps a step count outside the known phases", () => {
    assert.deepEqual(phaseTrail(0), ["chunk"]);
    assert.equal(phaseTrail(99).length, 5);
  });
});

describe("visibleCounters", () => {
  it("returns null for a phase that cannot count, so the bar sweeps", () => {
    assert.equal(visibleCounters({ phase: "chunk", done: 0, total: 0 }, null), null);
  });

  it("borrows the summary channel's numbers only while summarizing", () => {
    const summary = { done: 3, total: 12, phase: "sections" };
    assert.deepEqual(visibleCounters({ phase: "summarize", done: 0, total: 0 }, summary), { done: 3, total: 12 });
    assert.equal(visibleCounters({ phase: "chunk", done: 0, total: 0 }, summary), null);
  });

  it("never double-counts: the index channel wins whenever it has numbers", () => {
    assert.deepEqual(
      visibleCounters({ phase: "summarize", done: 5, total: 20 }, { done: 3, total: 12, phase: "sections" }),
      { done: 5, total: 20 },
    );
  });
});

const terminal = (state: IndexProgress["state"], over: Partial<IndexProgress> = {}): IndexProgress => ({
  state,
  phase: "summarize",
  step: 4,
  totalSteps: 5,
  done: 0,
  total: 0,
  ...over,
});

describe("runOutcome", () => {
  it("treats a stop as a stop and never as a failure", () => {
    // The reader pressed the button. Nothing here is an error, so nothing may
    // be routed through the screen's error path — the backend goes out of its
    // way to send `cancelled` rather than `failed` precisely so this stays
    // true, and it carries no message to show either.
    assert.equal(runOutcome(false, terminal("cancelled")), "stopped");
    assert.notEqual(runOutcome(false, terminal("cancelled")), "failed");
  });

  it("leaves the primary button reachable after a stop, because that is how you resume", () => {
    // A stopped run keeps everything its finished phases committed, so the
    // same press picks up from there. Reporting it as still running would put
    // that press out of reach for good.
    assert.notEqual(runOutcome(false, terminal("cancelled")), "running");
  });

  it("still calls a real failure a failure", () => {
    assert.equal(runOutcome(false, terminal("failed", { message: "no such model" })), "failed");
  });

  it("counts the gap before the first event as running, so the stop control is there from the press", () => {
    assert.equal(runOutcome(true, null), "running");
    // And a run in flight outranks the last run's terminal event, which is
    // still sitting in state until the first new event replaces it.
    assert.equal(runOutcome(true, terminal("cancelled")), "running");
  });

  it("has nothing to say about a clean finish or a window that has run nothing", () => {
    assert.equal(runOutcome(false, null), "settled");
    assert.equal(runOutcome(false, terminal("done")), "settled");
  });
});
