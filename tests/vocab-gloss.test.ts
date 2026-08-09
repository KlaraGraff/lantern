import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_GLOSS_WIDTH,
  clampGloss,
  condenseGloss,
  glossWidth,
  isShortGloss,
} from "../src/components/vocab/gloss.ts";

// The bug this module exists for: the learning card wrote its whole rendered
// text — heading, summary, details, examples — into `vocab_words.definition`,
// which is the string drawn *above the word* in the book. A 439-character
// English blob starting "Meaning in this context" was the result.
const CARD_BLOB = `Meaning in this context
The narrator uses "recount" in its older sense: to tell a story in order,
not to count something a second time.

Examples
- He recounted the voyage to anyone who would listen.`;

test("display width counts a full-width character as two columns", () => {
  assert.equal(glossWidth("tell"), 4);
  assert.equal(glossWidth("讲述"), 4);
  assert.equal(glossWidth(""), 0);
  // Mixed scripts add up rather than picking one rule for the whole string.
  assert.equal(glossWidth("讲述 tell"), 4 + 1 + 4);
});

test("condensing keeps the first meaningful line and drops model decoration", () => {
  assert.equal(condenseGloss("- **讲述、叙述**"), "讲述、叙述");
  assert.equal(condenseGloss('"to tell"'), "to tell");
  assert.equal(condenseGloss("`recount`"), "recount");
  assert.equal(condenseGloss("> 讲述。"), "讲述");
  assert.equal(condenseGloss("\n\n  to tell  \n\nmore prose here"), "to tell");
  assert.equal(condenseGloss("to  tell   a story"), "to tell a story");
  assert.equal(condenseGloss(null), "");
  assert.equal(condenseGloss(undefined), "");
});

test("a card blob is never mistaken for a gloss a caller can store as-is", () => {
  assert.equal(isShortGloss(CARD_BLOB), false);
  // Nor is a single line that is simply too wide to sit over a word.
  assert.equal(isShortGloss("to tell a story in order, not to count again"), false);
  assert.equal(isShortGloss(""), false);
  assert.equal(isShortGloss("   "), false);
  assert.equal(isShortGloss(null), false);
});

test("a short gloss is stored verbatim, in either script", () => {
  assert.equal(isShortGloss("讲述、叙述"), true);
  assert.equal(isShortGloss("to tell a story"), true);
  assert.equal(clampGloss("讲述、叙述"), "讲述、叙述");
  assert.equal(clampGloss("to tell a story"), "to tell a story");
});

// Truncation is the guard rail, never the mechanism — the model is asked for a
// short gloss and the offline dictionary is the fallback. But a runaway answer
// must not be allowed to sit over a word.
test("clamping is width-aware and marks what it cut", () => {
  const wide = "一".repeat(20);
  const clamped = clampGloss(wide);
  assert.ok(clamped.endsWith("…"));
  assert.ok(glossWidth(clamped) <= MAX_GLOSS_WIDTH);
  // Fifteen full-width characters plus the ellipsis is 31 columns; a
  // sixteenth would be 33.
  assert.equal(clamped, `${"一".repeat(15)}…`);

  const latin = clampGloss("a".repeat(40));
  assert.ok(glossWidth(latin) <= MAX_GLOSS_WIDTH);
  assert.equal(latin, `${"a".repeat(31)}…`);
});

test("clamping collapses the newlines a blob would otherwise carry into the row", () => {
  const clamped = clampGloss(CARD_BLOB.replace(/\n/g, " "));
  assert.ok(!clamped.includes("\n"));
  assert.ok(glossWidth(clamped) <= MAX_GLOSS_WIDTH);
});

test("an explicit narrower ceiling is honoured", () => {
  assert.equal(clampGloss("abcdefghij", 5), "abcd…");
  assert.equal(clampGloss("abc", 5), "abc");
});
