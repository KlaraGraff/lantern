import assert from "node:assert/strict";
import test from "node:test";

import {
  cfiFallsWithin,
  countHits,
  filterGroupsByScope,
  isSearchableQuery,
  normalizeExcerpt,
  type SearchChapterGroup,
} from "../src/pages/reader/book-search.ts";
import type { CfiModule } from "../src/pages/reader/book-search.ts";

// The containment check is exercised against the real vendored CFI module
// (pure string parsing, no DOM) rather than a stand-in, so the range/point
// math in the test matches what the reader actually compares in production.
const cfi = await import("../public/foliate-js/epubcfi.js") as unknown as CfiModule;

const hit = (offset: number): { cfi: string; excerpt: { pre: string; match: string; post: string } } => ({
  cfi: `epubcfi(/6/14!/4/2/3:${offset})`,
  excerpt: { pre: "…", match: "word", post: "…" },
});

const RANGE_5_20 = "epubcfi(/6/14!/4/2,/3:5,/3:20)";
const POINT_10 = "epubcfi(/6/14!/4/2/3:10)";

test("isSearchableQuery rejects empty and whitespace-only queries", () => {
  assert.equal(isSearchableQuery(""), false);
  assert.equal(isSearchableQuery("   "), false);
  assert.equal(isSearchableQuery("  a "), true);
});

test("cfiFallsWithin: a point inside a range CFI is contained", () => {
  assert.equal(cfiFallsWithin(hit(10).cfi, RANGE_5_20, cfi), true);
});

test("cfiFallsWithin: a point outside a range CFI is not contained", () => {
  assert.equal(cfiFallsWithin(hit(30).cfi, RANGE_5_20, cfi), false);
  assert.equal(cfiFallsWithin(hit(1).cfi, RANGE_5_20, cfi), false);
});

test("cfiFallsWithin: the range's own boundaries are inclusive", () => {
  assert.equal(cfiFallsWithin("epubcfi(/6/14!/4/2/3:5)", RANGE_5_20, cfi), true);
  assert.equal(cfiFallsWithin("epubcfi(/6/14!/4/2/3:20)", RANGE_5_20, cfi), true);
});

test("cfiFallsWithin: a point CFI (vocab) matches only the exact point", () => {
  assert.equal(cfiFallsWithin(POINT_10, POINT_10, cfi), true);
  assert.equal(cfiFallsWithin(hit(11).cfi, POINT_10, cfi), false);
});

test("cfiFallsWithin: an unparsable location is never a match", () => {
  assert.equal(cfiFallsWithin(POINT_10, "not a cfi", cfi), false);
});

const groups: SearchChapterGroup[] = [
  { label: "Chapter 1", hits: [hit(10), hit(30)] },
  { label: "Chapter 2", hits: [hit(10)] },
];

test("filterGroupsByScope: 'book' scope is the identity (but a fresh copy)", () => {
  const result = filterGroupsByScope(groups, "book", [], cfi);
  assert.deepEqual(result, groups);
  assert.notEqual(result, groups);
});

test("filterGroupsByScope: 'highlights' scope keeps only hits inside a highlight range, drops empty chapters", () => {
  const result = filterGroupsByScope(groups, "highlights", [RANGE_5_20], cfi);
  assert.deepEqual(result, [
    { label: "Chapter 1", hits: [hit(10)] },
    { label: "Chapter 2", hits: [hit(10)] },
  ]);
});

test("filterGroupsByScope: 'vocab' scope matches a point CFI and nothing else", () => {
  const result = filterGroupsByScope(groups, "vocab", [POINT_10], cfi);
  assert.deepEqual(result, [
    { label: "Chapter 1", hits: [hit(10)] },
    { label: "Chapter 2", hits: [hit(10)] },
  ]);
});

test("filterGroupsByScope: no scope locations at all leaves nothing", () => {
  assert.deepEqual(filterGroupsByScope(groups, "highlights", [], cfi), []);
});

test("countHits sums hits across all groups", () => {
  assert.equal(countHits(groups), 3);
  assert.equal(countHits([]), 0);
});

test("normalizeExcerpt fills in missing pieces as empty strings", () => {
  assert.deepEqual(normalizeExcerpt({ pre: "a", match: "b", post: "c" }), { pre: "a", match: "b", post: "c" });
  assert.deepEqual(normalizeExcerpt(undefined), { pre: "", match: "", post: "" });
  assert.deepEqual(normalizeExcerpt({ match: "only" }), { pre: "", match: "only", post: "" });
});
