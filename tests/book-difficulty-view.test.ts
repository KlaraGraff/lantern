import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  bandSlices,
  baselineHardShare,
  difficultyVerdict,
  easyShare,
  effectiveVerdict,
  formatShare,
  hardShare,
  MIN_BASELINE_BOOKS,
  VERDICT_MARGIN,
} from "../src/pages/book-details/difficulty-view.ts";
import { markEmphasis, splitEmphasis } from "../src/i18n/emphasis.ts";
import {
  LEVEL_OBSERVATION_KINDS,
  LEVEL_OBSERVATION_RULE_KEY,
  levelObservationKeys,
  levelObservationRuleKeys,
} from "../src/pages/reading-stats/level-observation.ts";

type Row = Parameters<typeof bandSlices>[0] & { status?: string };

function row(overrides: Partial<Row> = {}): Row {
  return {
    band1: 0,
    band2: 0,
    band3: 0,
    band4: 0,
    band5: 0,
    bandUnlisted: 0,
    totalTokens: 0,
    ...overrides,
  };
}

test("the distribution is six slices, with unlisted last and separate", () => {
  const slices = bandSlices(row({
    band1: 500, band2: 200, band3: 100, band4: 100, band5: 50, bandUnlisted: 50,
    totalTokens: 1000,
  }));
  assert.equal(slices.length, 6);
  assert.deepEqual(slices.map((slice) => slice.band), [1, 2, 3, 4, 5, null]);

  const unlisted = slices[5];
  assert.equal(unlisted.tokens, 50);
  assert.equal(unlisted.from, null);
  assert.equal(unlisted.to, null);
  // Band 5 keeps exactly its own count. Folding "not in the 50 000-word list"
  // into "rarer than rank 20 000" would make every book with an invented
  // place name read as rarer than it is.
  assert.equal(slices[4].tokens, 50);
  assert.notEqual(slices[4].color, unlisted.color);

  const total = slices.reduce((sum, slice) => sum + slice.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("an empty row produces six zero-width slices rather than NaN", () => {
  const slices = bandSlices(row());
  assert.equal(slices.length, 6);
  for (const slice of slices) assert.equal(slice.share, 0);
});

test("the hard share counts bands 4 and 5 only, never the unlisted bucket", () => {
  const sample = row({ band4: 60, band5: 40, bandUnlisted: 300, totalTokens: 1000 });
  assert.equal(hardShare(sample), 0.1);
  assert.equal(easyShare(row({ band1: 700, band2: 164, totalTokens: 1000 })), 0.864);
  assert.equal(hardShare(row()), 0);
});

test("a baseline needs at least two analyzed books", () => {
  const done = (share: number) => ({
    band4: share * 1000, band5: 0, totalTokens: 1000, status: "done" as const,
  });
  assert.equal(baselineHardShare([]), null);
  assert.equal(baselineHardShare([done(0.05)]), null);
  assert.equal(MIN_BASELINE_BOOKS, 2);
  assert.equal(baselineHardShare([done(0.02), done(0.04)]), 0.03);

  // Rows that never produced a distribution cannot vote, and a row that is
  // filtered out cannot count towards the floor either.
  const unusable = { band4: 0, band5: 0, totalTokens: 0, status: "too_short" as const };
  assert.equal(baselineHardShare([done(0.02), unusable]), null);
});

test("the verdict has a dead band around the baseline", () => {
  assert.equal(difficultyVerdict(0.084, null), "unclear");
  assert.equal(difficultyVerdict(0.084, 0.03), "harder");
  assert.equal(difficultyVerdict(0.032, 0.03), "similar");
  assert.equal(difficultyVerdict(0.005, 0.03), "easier");
  // Exactly at the margin counts as a difference; a hair inside does not.
  assert.equal(difficultyVerdict(0.03 + VERDICT_MARGIN, 0.03), "harder");
  assert.equal(difficultyVerdict(0.03 + VERDICT_MARGIN - 1e-9, 0.03), "similar");
  assert.equal(difficultyVerdict(0.03 - VERDICT_MARGIN, 0.03), "easier");
});

test("an override replaces the verdict and nothing else", () => {
  assert.equal(effectiveVerdict("harder", null), "harder");
  assert.equal(effectiveVerdict("harder", "matched"), "similar");
  assert.equal(effectiveVerdict("harder", "easier"), "easier");
  assert.equal(effectiveVerdict("harder", "harder"), "harder");
  assert.equal(effectiveVerdict("harder", "hidden"), "hidden");
  // Overriding an unclear verdict is the point of the control: the reader
  // read the book and the analysis did not.
  assert.equal(effectiveVerdict("unclear", "harder"), "harder");
});

test("shares are formatted to one decimal so the bar and the table agree", () => {
  assert.equal(formatShare(0.0841), "8.4");
  assert.equal(formatShare(1), "100.0");
  assert.equal(formatShare(0), "0.0");
});

test("emphasis survives a round trip and leaves plain strings alone", () => {
  const marked = `book ${markEmphasis("8.4%")} of it`;
  assert.deepEqual(splitEmphasis(marked), [
    { text: "book ", emphasis: false },
    { text: "8.4%", emphasis: true },
    { text: " of it", emphasis: false },
  ]);
  assert.deepEqual(splitEmphasis("no marks here"), [{ text: "no marks here", emphasis: false }]);
  assert.deepEqual(splitEmphasis(markEmphasis("all")), [{ text: "all", emphasis: true }]);
  // The marker never survives into rendered text.
  const MARKER = "\u0011";
  assert.ok(!splitEmphasis(marked).some((part) => part.text.includes(MARKER)));
});

/**
 * The sentence the level row is not allowed to ship without. It is the whole
 * licence for that row existing, so it is asserted here rather than trusted to
 * survive whatever the next branch in the renderer looks like.
 */
test("every level-observation variant carries the no-automatic-change rule", () => {
  for (const kind of LEVEL_OBSERVATION_KINDS) {
    for (const source of ["ai", "local"] as const) {
      const keys = levelObservationRuleKeys(kind, source);
      assert.equal(keys[0], LEVEL_OBSERVATION_RULE_KEY, `${kind}/${source} must lead with the rule`);
      assert.equal(
        keys.filter((key) => key === LEVEL_OBSERVATION_RULE_KEY).length,
        1,
        `${kind}/${source} must state the rule exactly once`,
      );
    }
  }
});

/**
 * The two word-class modes make different promises about what leaves the
 * machine, so each must state its own — never the other's, never both.
 */
test("the privacy sentence matches the word-class source that actually ran", () => {
  for (const kind of LEVEL_OBSERVATION_KINDS) {
    const ai = levelObservationRuleKeys(kind, "ai");
    const local = levelObservationRuleKeys(kind, "local");
    assert.ok(ai.includes("readingStats.levelObservation.ruleAi"), `${kind} ai`);
    assert.ok(!ai.includes("readingStats.levelObservation.ruleLocal"), `${kind} ai must not claim local-only`);
    assert.ok(local.includes("readingStats.levelObservation.ruleLocal"), `${kind} local`);
    assert.ok(!local.includes("readingStats.levelObservation.ruleAi"), `${kind} local must not mention the AI`);
  }
});

test("every key a level-observation variant asks for exists in every locale", () => {
  const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
  for (const locale of ["en.json", "zh.json"]) {
    const table = JSON.parse(readFileSync(path.join(i18nDir, locale), "utf8")) as Record<string, string>;
    for (const kind of LEVEL_OBSERVATION_KINDS) {
      for (const key of levelObservationKeys(kind)) {
        assert.ok(key in table, `${locale} is missing ${key} (needed by ${kind})`);
        assert.ok(table[key].trim().length > 0, `${locale} has an empty ${key}`);
      }
    }
    // Same check for the sentence itself, spelled out, so a rename of the
    // helper cannot make this test vacuous.
    assert.ok(LEVEL_OBSERVATION_RULE_KEY in table);
  }
});
