import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeExpandedPages,
  parseTocSavedState,
  serializeExpandedPages,
} from "../src/components/toc-state.ts";

test("mergeExpandedPages unions and dedups without mutating the base", () => {
  const base = new Set([1, 3]);
  const merged = mergeExpandedPages(base, [3, 5]);
  assert.deepEqual([...merged].sort(), [1, 3, 5]);
  assert.deepEqual([...base].sort(), [1, 3]);
});

test("restoring saved state unions with the current chapter's auto-expanded ancestors", () => {
  // A book was closed with sections 2 and 5 expanded; it reopens on a chapter
  // whose ancestor path is 5 -> 9. Restoring must not collapse that path.
  const restored = new Set([2, 5]);
  const autoExpandedAncestors = [5, 9];
  const merged = mergeExpandedPages(restored, autoExpandedAncestors);
  assert.deepEqual([...merged].sort((a, b) => a - b), [2, 5, 9]);
});

test("parseTocSavedState reads a valid saved row", () => {
  const state = parseTocSavedState({
    toc_expanded: JSON.stringify([2, 5, 9]),
    toc_scroll: "123.5",
  });
  assert.deepEqual(state.expandedPages, [2, 5, 9]);
  assert.equal(state.scrollTop, 123.5);
});

test("parseTocSavedState tolerates a missing row", () => {
  const state = parseTocSavedState({});
  assert.deepEqual(state.expandedPages, []);
  assert.equal(state.scrollTop, undefined);
});

test("parseTocSavedState falls back to collapsed on corrupt JSON", () => {
  const state = parseTocSavedState({ toc_expanded: "{not json" });
  assert.deepEqual(state.expandedPages, []);
});

test("parseTocSavedState drops non-integer entries and a negative or non-finite scroll value", () => {
  const state = parseTocSavedState({
    toc_expanded: JSON.stringify([1, "two", 3.5, 4]),
    toc_scroll: "-5",
  });
  assert.deepEqual(state.expandedPages, [1, 4]);
  assert.equal(state.scrollTop, undefined);
});

test("serializeExpandedPages produces a sorted, stable JSON array", () => {
  assert.equal(serializeExpandedPages(new Set([9, 2, 5])), "[2,5,9]");
  assert.equal(serializeExpandedPages([]), "[]");
});
