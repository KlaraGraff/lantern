import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/DictionaryContent.tsx", import.meta.url), "utf8");

/** The saved-list search box: the one input whose placeholder is `vocab.search`. */
function vocabSearchInput(): string {
  const at = source.indexOf('placeholder={t("vocab.search")}');
  assert.notEqual(at, -1, "the vocab search input is missing from DictionaryContent");
  const start = source.lastIndexOf("<input", at);
  const end = source.indexOf("/>", at);
  return source.slice(start, end);
}

test("the vocab search box renders the query that filters the list", () => {
  // `focusWord` (the command palette) sets `search` programmatically. An
  // uncontrolled `defaultValue=""` box would keep showing nothing while the
  // list below was filtered by a query the reader cannot see or clear.
  const input = vocabSearchInput();
  assert.match(input, /value=\{search\}/u);
  assert.doesNotMatch(input, /defaultValue=/u);
});
