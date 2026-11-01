import test from "node:test";
import assert from "node:assert/strict";

import { locateQuote } from "../src/pages/reader/quoteAnchoring.ts";

/** What `makeRange` would produce, read straight off the same string array. */
const slice = (
  strs: string[],
  r: { startIndex: number; startOffset: number; endIndex: number; endOffset: number },
) => r.startIndex === r.endIndex
  ? strs[r.startIndex].slice(r.startOffset, r.endOffset)
  : strs[r.startIndex].slice(r.startOffset)
    + strs.slice(r.startIndex + 1, r.endIndex).join("")
    + strs[r.endIndex].slice(0, r.endOffset);

test("an astral character before the quote does not shift the anchored range", () => {
  // A single text node: "😊 She walked to the bank." The emoji is one code
  // point but two UTF-16 units, and the offsets handed to `makeRange` are
  // UTF-16 offsets into that node.
  const strs = ["😊 She walked to the bank. Then home."];
  const found = locateQuote(strs, { exact: "She walked to the bank." });
  assert.ok(found);
  assert.equal(slice(strs, found), "She walked to the bank.");
});
