import assert from "node:assert/strict";
import test from "node:test";

import { parseArrivalPage } from "../src/pages/reader/arrival-page.ts";

test("an arrival address without a page parameter does not claim page 0", () => {
  // `/reader/<id>` — the ordinary way a PDF is reopened from the shelf.
  assert.equal(parseArrivalPage(undefined, null), undefined);
  // `?openVocab=true` from a vocabulary row, no page.
  assert.equal(parseArrivalPage(undefined, null), undefined);
});

test("an empty page parameter is not page 0 either", () => {
  assert.equal(parseArrivalPage(undefined, ""), undefined);
});

test("a real page parameter is still honoured", () => {
  assert.equal(parseArrivalPage(undefined, "0"), 0);
  assert.equal(parseArrivalPage(undefined, "12"), 12);
});

test("router state wins and a bad page is ignored", () => {
  assert.equal(parseArrivalPage(7, "12"), 7);
  assert.equal(parseArrivalPage(undefined, "-3"), undefined);
  assert.equal(parseArrivalPage(undefined, "abc"), undefined);
});
