import assert from "node:assert/strict";
import test from "node:test";

import { locateQuote } from "../src/pages/reader/quoteAnchoring.ts";

/** What `makeRange` would produce, read straight off the same string array. */
const slice = (strs: string[], r: { startIndex: number; startOffset: number; endIndex: number; endOffset: number }) =>
  r.startIndex === r.endIndex
    ? strs[r.startIndex].slice(r.startOffset, r.endOffset)
    : strs[r.startIndex].slice(r.startOffset)
      + strs.slice(r.startIndex + 1, r.endIndex).join("")
      + strs[r.endIndex].slice(0, r.endOffset);

const collapse = (str: string) => str.replace(/\s+/g, " ").trim();

test("a sentence inside one text node maps back to that node's offsets", () => {
  const strs = ["The river was cold. She went to the bank. The current was strong."];
  const found = locateQuote(strs, { exact: "She went to the bank." });
  assert.ok(found);
  assert.equal(found.startIndex, 0);
  assert.equal(found.endIndex, 0);
  assert.equal(slice(strs, found), "She went to the bank.");
});

test("a sentence broken across nodes by inline markup spans them", () => {
  // What `<p>She went to the <em>bank</em>.</p>` walks as.
  const strs = ["The river was cold. She went to the ", "bank", ". The current was strong."];
  const found = locateQuote(strs, { exact: "She went to the bank." });
  assert.ok(found);
  assert.equal(found.startIndex, 0);
  assert.equal(found.endIndex, 2);
  assert.equal(slice(strs, found), "She went to the bank.");
});

test("the line breaks and indentation of wrapped XHTML do not lose the sentence", () => {
  const strs = [
    "\n      The river was cold.\n      She went to the bank.\n      The current was strong.\n    ",
  ];
  const found = locateQuote(strs, { exact: "She went to the bank." });
  assert.ok(found);
  assert.equal(slice(strs, found), "She went to the bank.");
});

test("a quote spanning a line break covers the raw whitespace in between", () => {
  const strs = ["Opening.\n  She went to the bank.\n  The current was strong.\n  Closing."];
  const found = locateQuote(strs, {
    exact: "She went to the bank. The current was strong.",
  });
  assert.ok(found);
  assert.equal(collapse(slice(strs, found)), "She went to the bank. The current was strong.");
});

test("context spanning nodes still tells two identical sentences apart", () => {
  const strs = [
    "The money was gone by then. She went to the ",
    "bank",
    ". Filler that belongs to neither passage sits here. ",
    "The river was cold that morning. She went to the bank. Something after.",
  ];
  const found = locateQuote(strs, {
    exact: "She went to the bank.",
    prefix: "The river was cold that morning.",
  });
  assert.ok(found);
  assert.equal(found.startIndex, 3);
  assert.equal(slice(strs, found), "She went to the bank.");
});

test("a sentence that is not in this section anchors nowhere", () => {
  const strs = ["A chapter about beekeeping, hives, smoke, and patient hands."];
  assert.equal(locateQuote(strs, { exact: "The submarine surfaced at dawn." }), null);
});

test("an empty section anchors nowhere", () => {
  assert.equal(locateQuote([], { exact: "She went to the bank." }), null);
});

test("a quote reaching the end of the last node stays inside it", () => {
  const strs = ["Opening line. ", "The sentence we want."];
  const found = locateQuote(strs, { exact: "The sentence we want." });
  assert.ok(found);
  assert.equal(found.endIndex, 1);
  assert.equal(found.endOffset, strs[1].length);
  assert.equal(slice(strs, found), "The sentence we want.");
});
