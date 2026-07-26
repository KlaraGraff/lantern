import assert from "node:assert/strict";
import test from "node:test";

import { citationSearchProbes } from "../src/pages/reader/citationNavigation.ts";

test("keeps a short exact quote intact", () => {
  assert.deepEqual(citationSearchProbes({
    snippet: "a conference on logotherapy",
  }), ["a conference on logotherapy"]);
});

test("normalizes quote whitespace without dropping its final word", () => {
  assert.deepEqual(citationSearchProbes({
    snippet: "a conference\n  on logotherapy",
  }), ["a conference on logotherapy"]);
});

test("uses the complete sentence only after the exact quote", () => {
  assert.deepEqual(citationSearchProbes({
    snippet: "a conference on logotherapy",
    fallbackSnippet: "When I was nineteen, I spoke at a conference on logotherapy.",
  }), [
    "a conference on logotherapy",
    "When I was nineteen, I spoke at a conference on logotherapy.",
  ]);
});
