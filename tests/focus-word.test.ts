import assert from "node:assert/strict";
import test from "node:test";

import { focusWordFor } from "../src/components/focus-word.ts";

test("a word-shaped lookup becomes the query for example sentences", () => {
  assert.equal(focusWordFor("ephemeral"), "ephemeral");
  assert.equal(focusWordFor("  ephemeral \n"), "ephemeral");
  assert.equal(focusWordFor("well-worn"), "well-worn");
});

test("a Chinese word or idiom passes, having no spaces to be judged by", () => {
  assert.equal(focusWordFor("彷徨"), "彷徨");
  assert.equal(focusWordFor("刻舟求剑"), "刻舟求剑");
});

test("a passage is not a query — retrieval takes one word", () => {
  assert.equal(focusWordFor("the quick brown fox"), undefined);
  assert.equal(focusWordFor("他站在门口，很久没有动"), undefined);
});

test("a long unbroken run is a paste or a sentence, not a word", () => {
  assert.equal(focusWordFor("这是一段没有任何空格的很长的中文句子"), undefined);
  assert.equal(focusWordFor("他站在门口很久没有动"), undefined);
  assert.equal(focusWordFor("https://example.com/some/long/path"), undefined);
});

test("an empty or blank selection asks for nothing", () => {
  assert.equal(focusWordFor(""), undefined);
  assert.equal(focusWordFor("   "), undefined);
});
