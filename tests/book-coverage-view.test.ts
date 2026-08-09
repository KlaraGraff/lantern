import assert from "node:assert/strict";
import test from "node:test";

import {
  compositionSlices,
  countFamiliarFrom,
  coverageBand,
  coverageBounds,
  coverageReading,
  formatCoverage,
  groupUnknownWords,
  INTERVAL_WIDTH_LIMIT,
  isProfileEmpty,
  profileMovedOn,
  RARE_PREVIEW_LIMIT,
  SCALE_MIN,
  scalePosition,
  shareAfterLearning,
  shelfCoverageFrom,
  shelfCoverageLabel,
  THRESHOLD_ASSISTED,
  THRESHOLD_INDEPENDENT,
  unknownWordsCsv,
  wordChip,
} from "../src/pages/book-details/coverage-view.ts";
import { MIN_BASELINE_BOOKS } from "../src/pages/book-details/difficulty-view.ts";
import type { UnknownWord, VocabProfileSummary } from "../src/hooks/useBookCoverage.ts";

type Row = Parameters<typeof coverageReading>[0] & Parameters<typeof compositionSlices>[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    totalTokens: 0,
    masteredTokens: 0,
    familiarTokens: 0,
    nameTokens: 0,
    unknownTokens: 0,
    baselineBooks: 0,
    ...overrides,
  };
}

function word(overrides: Partial<UnknownWord> = {}): UnknownWord {
  return {
    word: "gunwale",
    tokens: 1,
    gloss: null,
    encounters: 0,
    lookups: 0,
    familiar: false,
    ...overrides,
  };
}

function summary(overrides: Partial<VocabProfileSummary> = {}): VocabProfileSummary {
  return {
    booksRead: 0,
    singleBookTitle: null,
    singleBookProgress: null,
    exposureTokens: 0,
    exposureWords: 0,
    lookupRecords: 0,
    lookupDays: 0,
    vocabWords: 0,
    reviewedWords: 0,
    masteredForms: 0,
    familiarForms: 0,
    updatedAt: null,
    ...overrides,
  };
}

test("the scale starts at 88% so both reference lines have room to stand", () => {
  assert.equal(SCALE_MIN, 0.88);
  assert.equal(scalePosition(0.88), 0);
  assert.equal(scalePosition(1), 1);
  // The mockup's two dashed lines: 95% at 58.33%, 98% at 83.33%.
  assert.equal(scalePosition(THRESHOLD_ASSISTED).toFixed(4), "0.5833");
  assert.equal(scalePosition(THRESHOLD_INDEPENDENT).toFixed(4), "0.8333");
});

test("a share below the scale's floor is pinned to it rather than drawn off-card", () => {
  assert.equal(scalePosition(0.4), 0);
  assert.equal(scalePosition(1.4), 1);
});

test("the two bounds differ by exactly the words the reader may or may not know", () => {
  const bounds = coverageBounds(row({
    totalTokens: 1000, masteredTokens: 881, familiarTokens: 58, nameTokens: 25,
  }));
  assert.equal(bounds.lower, 0.906);
  assert.equal(bounds.upper, 0.964);
});

test("a book with no words counted reads as zero rather than dividing by it", () => {
  assert.deepEqual(coverageBounds(row()), { lower: 0, upper: 0 });
});

test("a narrow range on enough books becomes one number", () => {
  const reading = coverageReading(row({
    totalTokens: 10_000, masteredTokens: 9_600, familiarTokens: 40, nameTokens: 0,
    baselineBooks: MIN_BASELINE_BOOKS,
  }), true);
  assert.equal(reading.kind, "point");
  if (reading.kind !== "point") return;
  assert.equal(formatCoverage(reading.share), "96.4");
  assert.equal(reading.band, "assisted");
});

test("with 眼熟 turned off the point is the lower bound, not a different sum", () => {
  const thin = row({
    totalTokens: 10_000, masteredTokens: 9_600, familiarTokens: 40, nameTokens: 0,
    baselineBooks: MIN_BASELINE_BOOKS,
  });
  const on = coverageReading(thin, true);
  const off = coverageReading(thin, false);
  assert.equal(on.kind, "point");
  assert.equal(off.kind, "point");
  if (on.kind !== "point" || off.kind !== "point") return;
  assert.equal(formatCoverage(on.share), "96.4");
  assert.equal(formatCoverage(off.share), "96.0");
});

test("one book behind the reader is a range however narrow the two bounds are", () => {
  const reading = coverageReading(row({
    totalTokens: 10_000, masteredTokens: 9_600, familiarTokens: 10, nameTokens: 0,
    baselineBooks: MIN_BASELINE_BOOKS - 1,
  }), true);
  assert.equal(reading.kind, "interval");
});

test("a range wider than a percentage point stays a range", () => {
  const reading = coverageReading(row({
    totalTokens: 10_000,
    masteredTokens: 9_310,
    familiarTokens: 480,
    nameTokens: 0,
    baselineBooks: 6,
  }), true);
  assert.equal(reading.kind, "interval");
  if (reading.kind !== "interval") return;
  assert.equal(formatCoverage(reading.low), "93.1");
  assert.equal(formatCoverage(reading.high), "97.9");
  // Straddles 95% — which is exactly why the card refuses a verdict here.
  assert.deepEqual(reading.spans, [THRESHOLD_ASSISTED]);
  assert.equal(reading.band, null);
});

test("a range that clears both lines still has a verdict to give", () => {
  const reading = coverageReading(row({
    totalTokens: 10_000, masteredTokens: 9_850, familiarTokens: 100, nameTokens: 0,
    baselineBooks: 1,
  }), true);
  assert.equal(reading.kind, "interval");
  if (reading.kind !== "interval") return;
  assert.deepEqual(reading.spans, []);
  assert.equal(reading.band, "independent");
});

test("the width gate is one percentage point, inclusive", () => {
  assert.equal(INTERVAL_WIDTH_LIMIT, 0.01);
  const atTheLimit = coverageReading(row({
    totalTokens: 10_000, masteredTokens: 9_000, familiarTokens: 100, nameTokens: 0,
    baselineBooks: 4,
  }), true);
  assert.equal(atTheLimit.kind, "point");
  const justOver = coverageReading(row({
    totalTokens: 10_000, masteredTokens: 9_000, familiarTokens: 101, nameTokens: 0,
    baselineBooks: 4,
  }), true);
  assert.equal(justOver.kind, "interval");
});

test("the three cells of the ladder are the two thresholds, not three colours", () => {
  assert.equal(coverageBand(0.918), "dense");
  assert.equal(coverageBand(THRESHOLD_ASSISTED), "assisted");
  assert.equal(coverageBand(0.964), "assisted");
  assert.equal(coverageBand(THRESHOLD_INDEPENDENT), "independent");
  assert.equal(coverageBand(0.986), "independent");
});

test("the composition is four rows, in order, summing to the book", () => {
  const slices = compositionSlices(row({
    totalTokens: 1000, masteredTokens: 881, familiarTokens: 58, nameTokens: 25,
    unknownTokens: 36,
  }));
  assert.deepEqual(slices.map((slice) => slice.key), ["mastered", "familiar", "name", "unknown"]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.tokens, 0), 1000);
  assert.equal(formatCoverage(slices[3].share), "3.6");
});

test("a reader with nothing recorded is empty, and one lookup is not", () => {
  assert.equal(isProfileEmpty(null), true);
  assert.equal(isProfileEmpty(summary()), true);
  assert.equal(isProfileEmpty(summary({ lookupRecords: 1 })), false);
  assert.equal(isProfileEmpty(summary({ exposureTokens: 40 })), false);
});

test("a profile updated after the row was computed is what dates the old number", () => {
  const computed = { profileAt: "2026-07-21T00:00:00Z" };
  assert.equal(profileMovedOn(computed, summary({ updatedAt: Date.parse("2026-08-08T00:00:00Z") })), true);
  assert.equal(profileMovedOn(computed, summary({ updatedAt: Date.parse("2026-07-01T00:00:00Z") })), false);
  assert.equal(profileMovedOn({ profileAt: null }, summary({ updatedAt: 1 })), false);
  assert.equal(profileMovedOn(computed, null), false);
});

test("the unknown words split at 40 and at 5 occurrences", () => {
  const groups = groupUnknownWords([
    word({ word: "forecastle", tokens: 96 }),
    word({ word: "gunwale", tokens: 41 }),
    word({ word: "squall", tokens: 34 }),
    word({ word: "cetology", tokens: 5 }),
    word({ word: "unctuousness", tokens: 4 }),
    word({ word: "interlacings", tokens: 1 }),
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["frequent", "recurring", "rare"]);
  assert.deepEqual(groups.map((group) => group.forms), [2, 2, 2]);
  assert.equal(groups[0].tokens, 137);
  assert.equal(groups[2].tokens, 5);
});

test("a group with nothing in it is not drawn as an empty heading", () => {
  const groups = groupUnknownWords([word({ tokens: 2 })]);
  assert.deepEqual(groups.map((group) => group.key), ["rare"]);
});

test("learning the densest group moves coverage by that group's share of the book", () => {
  assert.equal(formatCoverage(shareAfterLearning(0.918, 1903, 212_470)), "92.7");
  assert.equal(shareAfterLearning(0.99, 100_000, 100_000), 1);
  assert.equal(shareAfterLearning(0.5, 10, 0), 0.5);
});

test("the chip beside a word is its strongest piece of evidence", () => {
  assert.deepEqual(wordChip(word({ familiar: true, lookups: 3, encounters: 9 })), { kind: "familiar" });
  assert.deepEqual(wordChip(word({ lookups: 3, encounters: 9 })), { kind: "lookups", count: 3 });
  assert.deepEqual(wordChip(word({ encounters: 6 })), { kind: "seen", count: 6 });
  assert.deepEqual(wordChip(word()), { kind: "never" });
});

test("the rare group shows a handful before it says how many are left", () => {
  assert.equal(RARE_PREVIEW_LIMIT, 6);
});

test("眼熟 counts by default and the shelf stays quiet by default", () => {
  assert.equal(countFamiliarFrom({}), true);
  assert.equal(countFamiliarFrom({ coverage_count_familiar: "false" }), false);
  assert.equal(countFamiliarFrom({ coverage_count_familiar: "true" }), true);
  assert.equal(shelfCoverageFrom({}), false);
  assert.equal(shelfCoverageFrom({ coverage_show_on_shelf: "true" }), true);
});

test("a comma in a gloss the reader typed does not shift the export's columns", () => {
  const csv = unknownWordsCsv([
    word({ word: "leviathan", tokens: 84, gloss: "巨兽；（此书中指）鲸", encounters: 2 }),
    word({ word: "cetology", tokens: 12, gloss: 'whale "science", broadly' }),
  ]);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "word,tokens,gloss,encounters,lookups");
  assert.equal(lines[1], '"leviathan",84,"巨兽；（此书中指）鲸",2,0');
  assert.equal(lines[2], '"cetology",12,"whale ""science"", broadly",0,0');
});

test("a shelf badge is a point or it is nothing", () => {
  // Same book, same counts: confident enough for a number, and the setting
  // picks which of the two the badge shows.
  const settled = row({
    totalTokens: 10_000,
    masteredTokens: 9_500,
    familiarTokens: 60,
    nameTokens: 100,
    baselineBooks: MIN_BASELINE_BOOKS,
  });
  assert.equal(shelfCoverageLabel(settled, true), "96.6");
  assert.equal(shelfCoverageLabel(settled, false), "96.0");

  // Too few books behind the profile — the card would show a range, so the
  // badge shows nothing rather than picking an end of it.
  assert.equal(shelfCoverageLabel({ ...settled, baselineBooks: 1 }, true), null);
  // Enough books, but the "眼熟" band is too wide to round to one story.
  assert.equal(shelfCoverageLabel({ ...settled, familiarTokens: 400 }, true), null);
});
