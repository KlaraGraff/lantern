import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptParts } from "../src/components/learning-card/receipt.ts";

test("a fresh answer names its model and what was sent", () => {
  assert.deepEqual(receiptParts({ model: "deepseek-chat", cached: false, withBook: true }, "passage"), {
    model: "deepseek-chat",
    keys: ["learningCard.receipt.sent"],
  });
});

test("a word also owns up to its lookup history", () => {
  assert.deepEqual(receiptParts({ model: null, cached: false, withBook: false }, "word").keys, [
    "learningCard.receipt.sentBookless",
    "learningCard.receipt.wordMemory",
  ]);
});

test("a cached answer says nothing was sent", () => {
  assert.deepEqual(receiptParts({ model: "x", cached: true, withBook: true }, "word"), {
    model: null,
    keys: ["learningCard.receipt.cached"],
  });
});
