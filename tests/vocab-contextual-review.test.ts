import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextualReviewAnswer,
  contextualReviewCloze,
  contextualReviewProgress,
  contextualReviewSource,
  contextualSentenceMeaning,
} from "../src/components/vocab/contextual-review.ts";

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

describe("contextual review progress", () => {
  it("reports the first and last card of a round correctly", () => {
    assert.deepEqual(contextualReviewProgress(0, 12), { position: 1, total: 12, ratio: 1 / 12 });
    assert.deepEqual(contextualReviewProgress(11, 12), { position: 12, total: 12, ratio: 1 });
  });

  it("advances with the queue index", () => {
    assert.equal(contextualReviewProgress(2, 12).position, 3);
    assert.equal(contextualReviewProgress(2, 12).ratio, 0.25);
  });

  it("handles a single-item round", () => {
    assert.deepEqual(contextualReviewProgress(0, 1), { position: 1, total: 1, ratio: 1 });
  });

  it("never renders an out-of-range position", () => {
    assert.deepEqual(contextualReviewProgress(0, 0), { position: 0, total: 0, ratio: 0 });
    assert.deepEqual(contextualReviewProgress(-3, 4), { position: 1, total: 4, ratio: 0.25 });
    assert.deepEqual(contextualReviewProgress(9, 4), { position: 4, total: 4, ratio: 1 });
    assert.deepEqual(contextualReviewProgress(Number.NaN, 4), { position: 1, total: 4, ratio: 0.25 });
    assert.deepEqual(contextualReviewProgress(1, Number.NaN), { position: 0, total: 0, ratio: 0 });
  });
});

describe("contextual review source line", () => {
  it("pairs the book with its chapter when one is saved", () => {
    assert.deepEqual(contextualReviewSource("被讨厌的勇气", "第三夜", "未知来源"), {
      bookTitle: "被讨厌的勇气",
      chapter: "第三夜",
    });
  });

  it("returns a null chapter rather than a dangling separator", () => {
    assert.deepEqual(contextualReviewSource("被讨厌的勇气", null, "未知来源"), {
      bookTitle: "被讨厌的勇气",
      chapter: null,
    });
    assert.deepEqual(contextualReviewSource("被讨厌的勇气", "   ", "未知来源"), {
      bookTitle: "被讨厌的勇气",
      chapter: null,
    });
    assert.deepEqual(contextualReviewSource("被讨厌的勇气", undefined, "未知来源"), {
      bookTitle: "被讨厌的勇气",
      chapter: null,
    });
  });

  it("falls back to the unknown-book label and trims both parts", () => {
    assert.deepEqual(contextualReviewSource("  ", "  第三夜 ", "未知来源"), {
      bookTitle: "未知来源",
      chapter: "第三夜",
    });
    assert.deepEqual(contextualReviewSource(null, null, "未知来源"), {
      bookTitle: "未知来源",
      chapter: null,
    });
  });

  it("drops a chapter that just repeats the book title", () => {
    assert.deepEqual(contextualReviewSource("Walden", "Walden", "Unknown source"), {
      bookTitle: "Walden",
      chapter: null,
    });
  });
});
