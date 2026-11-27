import assert from "node:assert/strict";
import test from "node:test";

import { readingStatsEmptyState } from "../src/pages/reading-stats/empty-state.ts";

const empty = { overview: { sessionCount: 0 } } as Parameters<typeof readingStatsEmptyState>[1];
const some = { overview: { sessionCount: 3 } } as Parameters<typeof readingStatsEmptyState>[1];

// The page opens on "this year". Someone who only read last year used to get
// the header-less first-use screen and could never reach "All time".
test("an empty 'this year' with older history is a filtered empty, not first use", () => {
  assert.equal(readingStatsEmptyState({ range: "year", bookId: null }, empty), "unknown");
  assert.equal(readingStatsEmptyState({ range: "year", bookId: null }, empty, 12), "filtered");
});

test("one book over the last 30 days with nothing in it keeps the controls", () => {
  assert.equal(readingStatsEmptyState({ range: "last30Days", bookId: "b1" }, empty, 4), "filtered");
});

test("no history anywhere is first use, whichever view asked", () => {
  assert.equal(readingStatsEmptyState({ range: "year", bookId: null }, empty, 0), "firstUse");
  assert.equal(readingStatsEmptyState({ range: "all", bookId: null }, empty), "firstUse");
});

test("a view with sessions is not empty", () => {
  assert.equal(readingStatsEmptyState({ range: "year", bookId: null }, some), "none");
});
