import assert from "node:assert/strict";
import test from "node:test";

import {
  crossBookReturnState,
  parseCrossBookJump,
  quoteIsReachable,
} from "../src/pages/reader/crossBookJump.ts";

const quote = {
  marker: "Q1",
  bookId: "other-book",
  bookTitle: "Another Book",
  sectionIndex: 3,
  text: "An example sentence.",
  prefix: "Before it.",
  suffix: "After it.",
};

const jump = {
  crossBookJump: {
    quote,
    from: { bookId: "this-book", cfi: "epubcfi(/6/4!/4/2)", title: "This Book" },
  },
};

test("a well-formed jump round-trips out of navigation state", () => {
  const parsed = parseCrossBookJump(jump);
  assert.ok(parsed);
  assert.equal(parsed.quote.text, "An example sentence.");
  assert.equal(parsed.from.bookId, "this-book");
  assert.equal(parsed.from.title, "This Book");
  assert.deepEqual(crossBookReturnState(parsed), { cfi: "epubcfi(/6/4!/4/2)" });
});

test("a book with no CFI addressing still offers a return, just no position", () => {
  const parsed = parseCrossBookJump({
    crossBookJump: { quote, from: { bookId: "a-pdf", title: "A PDF" } },
  });
  assert.ok(parsed);
  assert.deepEqual(crossBookReturnState(parsed), {});
});

test("navigation state from anywhere else is not a jump", () => {
  assert.equal(parseCrossBookJump(null), null);
  assert.equal(parseCrossBookJump({ openChat: true }), null);
  assert.equal(parseCrossBookJump({ crossBookJump: "yes" }), null);
});

test("a half-shaped record is rejected rather than half-followed", () => {
  const missingQuote = { crossBookJump: { from: jump.crossBookJump.from } };
  const missingOrigin = { crossBookJump: { quote } };
  const emptyBookId = {
    crossBookJump: { quote, from: { bookId: "", title: "This Book" } },
  };
  const brokenQuote = {
    crossBookJump: {
      quote: { ...quote, sectionIndex: "3" },
      from: jump.crossBookJump.from,
    },
  };
  for (const state of [missingQuote, missingOrigin, emptyBookId, brokenQuote]) {
    assert.equal(parseCrossBookJump(state), null);
  }
});

test("a quote whose book has left the library can be named but not opened", () => {
  assert.equal(quoteIsReachable(quote, new Set(["other-book", "this-book"])), true);
  assert.equal(quoteIsReachable(quote, new Set(["this-book"])), false);
});
