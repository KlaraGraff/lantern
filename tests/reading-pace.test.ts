import assert from "node:assert/strict";
import test from "node:test";

import {
  averageSecondsPerPage,
  averageSecondsPerPercent,
  derivePaceSample,
  minutesLeftInBook,
  minutesLeftInChapter,
  PACE_MAX_ELAPSED_MS,
  PACE_MAX_PAGE_ADVANCE,
  PACE_MIN_ELAPSED_MS,
  PACE_MIN_SAMPLES,
  PACE_WINDOW_SIZE,
  type PageTurnSnapshot,
  pushPaceSample,
} from "../src/pages/reader/reading-pace.ts";

function snapshot(overrides: Partial<PageTurnSnapshot>): PageTurnSnapshot {
  return { sectionIndex: 0, page: 1, progress: 0, timestampMs: 0, ...overrides };
}

test("derivePaceSample returns null with no previous snapshot", () => {
  assert.equal(derivePaceSample(null, snapshot({})), null);
});

test("derivePaceSample returns null across a chapter change", () => {
  const previous = snapshot({ sectionIndex: 0, page: 10, progress: 10, timestampMs: 0 });
  const next = snapshot({ sectionIndex: 1, page: 1, progress: 11, timestampMs: 5000 });
  assert.equal(derivePaceSample(previous, next), null);
});

test("derivePaceSample returns null for a backward turn", () => {
  const previous = snapshot({ page: 5, progress: 10, timestampMs: 0 });
  const next = snapshot({ page: 4, progress: 9, timestampMs: 5000 });
  assert.equal(derivePaceSample(previous, next), null);
});

test("derivePaceSample returns null for a jump beyond PACE_MAX_PAGE_ADVANCE", () => {
  const previous = snapshot({ page: 1, progress: 1, timestampMs: 0 });
  const next = snapshot({
    page: 1 + PACE_MAX_PAGE_ADVANCE + 1,
    progress: 5,
    timestampMs: 5000,
  });
  assert.equal(derivePaceSample(previous, next), null);
});

test("derivePaceSample returns null when idle longer than PACE_MAX_ELAPSED_MS", () => {
  const previous = snapshot({ page: 1, progress: 1, timestampMs: 0 });
  const next = snapshot({ page: 2, progress: 2, timestampMs: PACE_MAX_ELAPSED_MS + 1 });
  assert.equal(derivePaceSample(previous, next), null);
});

test("derivePaceSample returns null for a near-duplicate event under PACE_MIN_ELAPSED_MS", () => {
  const previous = snapshot({ page: 1, progress: 1, timestampMs: 0 });
  const next = snapshot({ page: 2, progress: 2, timestampMs: PACE_MIN_ELAPSED_MS - 1 });
  assert.equal(derivePaceSample(previous, next), null);
});

test("derivePaceSample accepts an ordinary single-page turn", () => {
  const previous = snapshot({ page: 1, progress: 1, timestampMs: 0 });
  const next = snapshot({ page: 2, progress: 2, timestampMs: 10_000 });
  assert.deepEqual(derivePaceSample(previous, next), {
    elapsedMs: 10_000,
    pageDelta: 1,
    percentDelta: 1,
  });
});

test("pushPaceSample keeps only the most recent PACE_WINDOW_SIZE samples", () => {
  const sample = { elapsedMs: 1000, pageDelta: 1, percentDelta: 1 };
  let window: ReturnType<typeof pushPaceSample> = [];
  for (let i = 0; i < PACE_WINDOW_SIZE + 3; i++) {
    window = pushPaceSample(window, { ...sample, elapsedMs: i });
  }
  assert.equal(window.length, PACE_WINDOW_SIZE);
  assert.equal(window[0].elapsedMs, 3);
  assert.equal(window[window.length - 1].elapsedMs, PACE_WINDOW_SIZE + 2);
});

test("averageSecondsPerPage is null below PACE_MIN_SAMPLES", () => {
  const window = Array.from({ length: PACE_MIN_SAMPLES - 1 }, () => ({
    elapsedMs: 10_000,
    pageDelta: 1,
    percentDelta: 1,
  }));
  assert.equal(averageSecondsPerPage(window), null);
});

test("averageSecondsPerPage aggregates total time over total pages", () => {
  const window = [
    { elapsedMs: 10_000, pageDelta: 1, percentDelta: 1 },
    { elapsedMs: 20_000, pageDelta: 2, percentDelta: 2 },
    { elapsedMs: 30_000, pageDelta: 1, percentDelta: 1 },
  ];
  // total seconds = 60, total pages = 4 -> 15s/page
  assert.equal(averageSecondsPerPage(window), 15);
});

test("averageSecondsPerPercent aggregates total time over total percent", () => {
  const window = [
    { elapsedMs: 10_000, pageDelta: 1, percentDelta: 2 },
    { elapsedMs: 20_000, pageDelta: 1, percentDelta: 2 },
    { elapsedMs: 30_000, pageDelta: 1, percentDelta: 2 },
  ];
  // total seconds = 60, total percent = 6 -> 10s/percent
  assert.equal(averageSecondsPerPercent(window), 10);
});

test("minutesLeftInChapter is null without an estimate", () => {
  assert.equal(minutesLeftInChapter(null, 10), null);
});

test("minutesLeftInChapter rounds and floors at zero", () => {
  assert.equal(minutesLeftInChapter(30, 10), 5); // 300s = 5min
  assert.equal(minutesLeftInChapter(30, -5), 0);
});

test("minutesLeftInBook is null without an estimate", () => {
  assert.equal(minutesLeftInBook(null, 10), null);
});

test("minutesLeftInBook rounds and floors at zero", () => {
  assert.equal(minutesLeftInBook(60, 10), 10); // 600s = 10min
  assert.equal(minutesLeftInBook(60, -1), 0);
});
