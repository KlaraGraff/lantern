import assert from "node:assert/strict";
import test from "node:test";

import {
  averageSecondsPerPage,
  averageSecondsPerPercent,
  derivePaceSample,
  minutesLeftInChapter,
  PACE_MIN_SAMPLES,
  type PaceSample,
  type PageTurnSnapshot,
} from "../src/pages/reader/reading-pace.ts";

function snapshot(overrides: Partial<PageTurnSnapshot>): PageTurnSnapshot {
  return { sectionIndex: 0, page: 1, progress: 0, timestampMs: 0, ...overrides };
}

// A 400-page book moves less than one whole-book percent per screen, so two
// consecutive ordinary page turns report the same rounded `progress`. That used
// to reject the sample outright and starve the pace window, leaving "time left
// in this chapter" on "calculating…" for a whole session.
test("a page turn still feeds the pace window when whole-book progress rounds to the same percent", () => {
  const previous = snapshot({ page: 10, progress: 42, timestampMs: 0 });
  const next = snapshot({ page: 11, progress: 42, timestampMs: 12_000 });
  const sample = derivePaceSample(previous, next);
  assert.ok(sample, "a 12s single-page turn must qualify even when progress stays at 42");
  assert.equal(sample.pageDelta, 1);
  assert.equal(sample.elapsedMs, 12_000);
  assert.equal(sample.percentDelta, 0);
});

test("those samples add up to a real chapter time estimate", () => {
  const sample = derivePaceSample(
    snapshot({ page: 10, progress: 42, timestampMs: 0 }),
    snapshot({ page: 11, progress: 42, timestampMs: 12_000 }),
  ) as PaceSample;
  assert.ok(sample);
  const window: PaceSample[] = Array.from({ length: PACE_MIN_SAMPLES }, () => sample);
  assert.equal(averageSecondsPerPage(window), 12);
  assert.equal(minutesLeftInChapter(12, 20), 4);
});

test("a turn that regresses whole-book progress is still rejected", () => {
  const previous = snapshot({ page: 10, progress: 42, timestampMs: 0 });
  const next = snapshot({ page: 11, progress: 41, timestampMs: 12_000 });
  assert.equal(derivePaceSample(previous, next), null);
});

// The other half of the same defect: whole-book progress is an integer, so a
// turn can carry no percentage at all. Charging its seconds against the percent
// some other turn covered would inflate "time left in the book".
test("book time spreads every turn's seconds over the percent moved", () => {
  const slow = { elapsedMs: 12_000, pageDelta: 1, percentDelta: 0 };
  const mover = { elapsedMs: 12_000, pageDelta: 1, percentDelta: 1 };
  // 72s of reading moved 3 percentage points -> 24s per point.
  assert.equal(averageSecondsPerPercent([slow, mover, slow, mover, slow, mover]), 24);
});

test("book time stays null when no sample moved the percentage", () => {
  const slow = { elapsedMs: 12_000, pageDelta: 1, percentDelta: 0 };
  assert.equal(averageSecondsPerPercent([slow, slow, slow]), null);
});
