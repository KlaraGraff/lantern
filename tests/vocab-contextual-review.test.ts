import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextualReviewAnswer, contextualReviewCloze, contextualSentenceMeaning } from "../src/components/vocab/contextual-review.ts";

describe("contextual vocabulary review", () => {
  it("matches a word case-insensitively and preserves the saved sentence", () => {
    assert.deepEqual(contextualReviewCloze("True Courage remains.", "courage"), { before: "True ", after: " remains." });
  });

  it("matches the first complete phrase", () => {
    assert.deepEqual(contextualReviewCloze("To take part is to participate.", "take part"), { before: "To ", after: " is to participate." });
    assert.equal(contextualReviewCloze("A stake parting from shore.", "take part"), null);
  });

  it("supports Unicode word boundaries and rejects substring-only matches", () => {
    assert.deepEqual(contextualReviewCloze("这是勇气。", "勇气"), { before: "这是", after: "。" });
    assert.equal(contextualReviewCloze("A partial answer.", "art"), null);
  });

  it("falls back for missing context or targets without leaking blank length", () => {
    assert.equal(contextualReviewCloze("  ", "word"), null);
    assert.equal(contextualReviewCloze("No match here.", "word"), null);
    const cloze = contextualReviewCloze("A word here.", "word");
    assert.deepEqual(Object.keys(cloze ?? {}), ["before", "after"]);
  });

  it("preserves the matched source text for the revealed answer", () => {
    assert.deepEqual(contextualReviewAnswer("True COURAGE remains.", "courage"), {
      before: "True ",
      answer: "COURAGE",
      after: " remains.",
    });
  });

  it("only exposes a nonblank saved sentence meaning", () => {
    assert.equal(contextualSentenceMeaning("  中文句意 "), "中文句意");
    assert.equal(contextualSentenceMeaning("  "), null);
    assert.equal(contextualSentenceMeaning(null), null);
  });
});
