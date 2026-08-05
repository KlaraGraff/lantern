import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextualReviewAnswer, contextualReviewCloze, contextualSentenceMeaning } from "../src/components/vocab/contextual-review.ts";

function visibleText(cloze: ReturnType<typeof contextualReviewCloze>) {
  return cloze?.segments.filter((segment) => !segment.hidden).map((segment) => segment.text).join("") ?? "";
}

describe("contextual vocabulary review", () => {
  it("matches a word case-insensitively and preserves the saved sentence", () => {
    const cloze = contextualReviewCloze("True Courage remains.", "courage");
    assert.deepEqual(cloze, { segments: [{ text: "True ", hidden: false }, { text: "Courage", hidden: true }, { text: " remains.", hidden: false }] });
  });

  it("matches the first complete phrase", () => {
    const cloze = contextualReviewCloze("To take part is to participate.", "take part");
    assert.deepEqual(cloze, { segments: [{ text: "To ", hidden: false }, { text: "take part", hidden: true }, { text: " is to participate.", hidden: false }] });
    assert.equal(contextualReviewCloze("A stake parting from shore.", "take part"), null);
  });

  it("supports Unicode word boundaries and rejects substring-only matches", () => {
    const cloze = contextualReviewCloze("这是勇气。", "勇气");
    assert.deepEqual(cloze, { segments: [{ text: "这是", hidden: false }, { text: "勇气", hidden: true }, { text: "。", hidden: false }] });
    assert.equal(contextualReviewCloze("A partial answer.", "art"), null);
  });

  it("blanks every occurrence so the answer never leaks through a repeated word", () => {
    const cloze = contextualReviewCloze("The light was the only light left.", "light");
    assert.ok(cloze);
    assert.equal(visibleText(cloze).toLowerCase().includes("light"), false);
    const hiddenCount = cloze!.segments.filter((segment) => segment.hidden).length;
    assert.equal(hiddenCount, 2);
  });

  it("falls back for missing context or targets without leaking blank length", () => {
    assert.equal(contextualReviewCloze("  ", "word"), null);
    assert.equal(contextualReviewCloze("No match here.", "word"), null);
    const cloze = contextualReviewCloze("A word here.", "word");
    assert.deepEqual(Object.keys(cloze ?? {}), ["segments"]);
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
