import test from "node:test";
import assert from "node:assert/strict";
import { toPlainText } from "../src/utils/plain-text.ts";

test("strips tags from a publisher blurb", () => {
  assert.equal(
    toPlainText("<p>A tale of a mole.</p><p><i>Illustrated</i></p>"),
    "A tale of a mole. Illustrated",
  );
});

test("keeps a word boundary at a block edge", () => {
  assert.equal(toPlainText("<p>one</p><p>two</p>"), "one two");
});

test("does not weld words across an inline tag", () => {
  // Inline tags carry no boundary of their own; the text around them does.
  assert.equal(toPlainText("a <b>bold</b> word"), "a bold word");
});

test("decodes the entities that show up in real metadata", () => {
  assert.equal(toPlainText("Bill &amp; Ben &#8212; a study&hellip;"), "Bill & Ben — a study…");
});

test("decodes an escaped entity exactly once", () => {
  assert.equal(toPlainText("&amp;lt;"), "&lt;");
});

test("leaves an unknown entity alone", () => {
  assert.equal(toPlainText("50&deg; north"), "50&deg; north");
});

test("survives malformed markup without throwing", () => {
  assert.equal(toPlainText("<p>unclosed <em>text"), "unclosed text");
  assert.equal(toPlainText("&#999999999;"), "&#999999999;");
});

test("collapses the whitespace an EPUB pretty-printer leaves behind", () => {
  assert.equal(toPlainText("\n  <p>\n    spaced   out\n  </p>\n"), "spaced out");
});

test("passes plain prose through untouched", () => {
  assert.equal(toPlainText("A field guide to lichens."), "A field guide to lichens.");
});
