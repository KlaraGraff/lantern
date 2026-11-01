import assert from "node:assert/strict";
import test from "node:test";

import { compactTokens, needsUnit } from "../src/components/settings/auto-analysis.ts";

test("a total just under a unit boundary prints in the same precision as the unit itself", () => {
  // 9,999 tokens is 9.999 k: rounding to one decimal carries it to ten, which
  // is no longer "below ten" and must not print the decimal the boundary exists
  // to avoid. Exactly 10,000 already prints "10".
  assert.equal(compactTokens(10_000, "k"), "10");
  assert.equal(compactTokens(9_999, "k"), "10");
  // Same carry in the 万 grouping: 99,950 is 9.995 万.
  assert.equal(compactTokens(100_000, "wan"), "10");
  assert.equal(compactTokens(99_950, "wan"), "10");
});

test("genuinely single-digit totals still carry one decimal, and sub-unit totals stay exact", () => {
  assert.equal(compactTokens(9_900, "k"), "9.9");
  assert.equal(compactTokens(48_300, "k"), "48");
  assert.equal(compactTokens(44_500, "wan"), "4.5");
  assert.equal(compactTokens(900, "k"), "900");
  assert.equal(needsUnit(9_999, "k"), true);
  assert.equal(needsUnit(999, "k"), false);
});
