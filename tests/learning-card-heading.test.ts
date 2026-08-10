import assert from "node:assert/strict";
import test from "node:test";
import { isRedundantHeading } from "../src/components/learning-card/heading.ts";

// The bug this exists for: the card prints "当前语境含义" over the module and the
// model opened the module with "语境含义", so the reader read the same words
// twice before reaching a single word of meaning.

test("a heading the module title already contains is dropped", () => {
  assert.equal(isRedundantHeading("语境含义", "当前语境含义"), true);
  assert.equal(isRedundantHeading("常用搭配", "常用搭配"), true);
  assert.equal(isRedundantHeading("Context meaning", "Context meaning in use"), true);
});

test("markdown and trailing punctuation do not save a restatement", () => {
  assert.equal(isRedundantHeading("**语境含义**", "当前语境含义"), true);
  assert.equal(isRedundantHeading("语境含义：", "当前语境含义"), true);
  assert.equal(isRedundantHeading("「语境含义」", "当前语境含义"), true);
  assert.equal(isRedundantHeading(" context meaning ", "Context Meaning"), true);
});

test("a heading that adds words the title lacks is content and stays", () => {
  // The lemma under "Word info" — the only heading worth its line.
  assert.equal(isRedundantHeading("render", "单词信息"), false);
  assert.equal(isRedundantHeading("词形信息", "单词信息"), false);
  // Longer than the title, so it is saying something the title does not.
  assert.equal(isRedundantHeading("Tone shift", "Tone"), false);
});

test("nothing to compare means nothing is dropped", () => {
  assert.equal(isRedundantHeading(undefined, "当前语境含义"), false);
  assert.equal(isRedundantHeading("语境含义", undefined), false);
  assert.equal(isRedundantHeading("  ", "当前语境含义"), false);
  assert.equal(isRedundantHeading("**", "当前语境含义"), false);
});
