import assert from "node:assert/strict";
import test from "node:test";

import {
  compactTokens,
  consoleWindowStart,
  groupJobsByFamily,
  needsUnit,
  tokenScaleFor,
  type AutoAnalysisJobView,
} from "../src/components/settings/auto-analysis.ts";

function job(overrides: Partial<AutoAnalysisJobView> & { id: string; trigger: string }): AutoAnalysisJobView {
  return {
    enabled: true,
    autoCalls: 0,
    autoTokens: 0,
    manualRuns: 0,
    recommendAuto: false,
    ...overrides,
  };
}

test("counts in the unit the reader's language counts in", () => {
  assert.equal(tokenScaleFor("zh"), "wan");
  assert.equal(tokenScaleFor("zh-CN"), "wan");
  assert.equal(tokenScaleFor("en"), "k");
  assert.equal(tokenScaleFor(undefined), "k");
});

test("one decimal below ten, none above it", () => {
  assert.equal(compactTokens(15_000, "wan"), "1.5");
  assert.equal(compactTokens(480_000, "wan"), "48");
  assert.equal(compactTokens(1_500, "k"), "1.5");
  assert.equal(compactTokens(480_000, "k"), "480");
});

test("a small total prints as itself rather than a rounding artefact", () => {
  // The first reader to ever trigger one automatic call should see what it
  // cost, not "0.0".
  assert.equal(compactTokens(900, "wan"), "900");
  assert.equal(needsUnit(900, "wan"), false);
  assert.equal(compactTokens(0, "wan"), "0");
  assert.equal(needsUnit(10_000, "wan"), true);
});

test("a nonsense token count never reaches the screen", () => {
  assert.equal(compactTokens(Number.NaN, "k"), "0");
  assert.equal(compactTokens(-5, "k"), "0");
  assert.equal(compactTokens(Number.POSITIVE_INFINITY, "k"), "0");
});

test("the window is the last thirty days", () => {
  const now = 1_800_000_000_000;
  assert.equal(now - consoleWindowStart(now), 30 * 24 * 60 * 60 * 1000);
});

test("groups follow what a job is for, not when it runs", () => {
  const grouped = groupJobsByFamily([
    job({ id: "user_profile", trigger: "batch" }),
    job({ id: "reading_review", trigger: "book_finished" }),
    job({ id: "person_aliases", trigger: "book_imported" }),
  ]);
  assert.deepEqual(
    grouped.map(([family]) => family),
    ["retrieval", "review", "personalization"],
  );
});

test("a job this build has never heard of still gets a heading", () => {
  // A switch the reader cannot see is a switch they cannot turn off, so an
  // unrecognised job sorts last instead of dropping out of the console.
  const grouped = groupJobsByFamily([
    job({ id: "moon_phase_summaries", trigger: "daily" }),
    job({ id: "reading_review", trigger: "book_finished" }),
  ]);
  assert.deepEqual(
    grouped.map(([family]) => family),
    ["review", "other"],
  );
});

test("inside a family, the earliest moment in a book's life leads", () => {
  const grouped = groupJobsByFamily([
    job({ id: "review_pile_curation", trigger: "daily" }),
    job({ id: "reading_review", trigger: "book_finished" }),
  ]);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0][1].map((entry) => entry.id), [
    "reading_review",
    "review_pile_curation",
  ]);
});
