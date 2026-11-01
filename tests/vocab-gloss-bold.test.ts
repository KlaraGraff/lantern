import assert from "node:assert/strict";
import test from "node:test";

import { glossOf } from "../src/components/vocab/entry-text.ts";

// A definition that reaches the row still carrying the model's decoration must
// read as a gloss, not as a gloss plus a dangling marker. `condenseGloss` in
// gloss.ts already drops every `**` pair for the same reason; `glossOf` is the
// function the collapsed row, the merged entry's sibling list and the review
// list all print from, and it only stripped a marker at the start of the line.
test("glossOf drops the closing bold marker of a bolded gloss", () => {
  assert.equal(glossOf("**讲述、叙述**"), "讲述、叙述");
  assert.equal(glossOf("**bold** gloss"), "bold gloss");
  assert.equal(glossOf("`careful`"), "careful");
});
