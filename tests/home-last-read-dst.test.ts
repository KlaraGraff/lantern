import assert from "node:assert/strict";
import test from "node:test";

import { lastReadOf } from "../src/pages/home/home-dashboard-model.ts";
import {
  coverageReading,
  THRESHOLD_ASSISTED,
  THRESHOLD_INDEPENDENT,
} from "../src/pages/book-details/coverage-view.ts";

/**
 * Runs `body` with the process timezone set to a zone that changes its offset,
 * and restores it afterwards. `Date` re-reads `TZ` on each call on POSIX, which
 * is the only way to reach a DST transition from a unit test.
 */
function inZone<T>(zone: string, body: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("yesterday is a calendar day, not a 24-hour span, across a DST change", () => {
  const zoneWorks = inZone("America/New_York", () => new Date(2026, 6, 1).getTimezoneOffset());
  if (zoneWorks === 0) return; // A platform where TZ cannot be set at runtime.

  inZone("America/New_York", () => {
    // Fall back: 2026-11-01 is 25 hours long in this zone. Read at 00:30 that
    // day and look again at noon on the 2nd — one night earlier, so the card
    // must say "yesterday", not "2 days ago".
    const now = new Date(2026, 10, 2, 12);
    assert.deepEqual(lastReadOf(new Date(2026, 10, 1, 0, 30).getTime(), now), { kind: "yesterday" });
    assert.deepEqual(lastReadOf(new Date(2026, 10, 1, 23, 30).getTime(), now), { kind: "yesterday" });

    // Three calendar days back is three, never four.
    assert.deepEqual(
      lastReadOf(new Date(2026, 10, 1, 0, 0).getTime(), new Date(2026, 10, 4, 12)),
      { kind: "daysAgo", days: 3 },
    );

    // Spring forward (23-hour day) keeps working too.
    assert.deepEqual(
      lastReadOf(new Date(2026, 2, 8, 23, 30).getTime(), new Date(2026, 2, 10, 12)),
      { kind: "daysAgo", days: 2 },
    );
  });
});

test("a range that crosses both reference lines reports both of them", () => {
  // Arithmetic, not wording: `coverageReading` is what tells the card how many
  // lines a range straddles, and it must report every one of them.
  const reading = coverageReading(
    {
      totalTokens: 1000,
      masteredTokens: 500,
      familiarTokens: 490,
      nameTokens: 0,
      baselineBooks: 1,
    },
    true,
  );
  assert.equal(reading.kind, "interval");
  if (reading.kind !== "interval") return;
  assert.deepEqual(reading.spans, [THRESHOLD_ASSISTED, THRESHOLD_INDEPENDENT]);
});
