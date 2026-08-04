import assert from "node:assert/strict";
import test from "node:test";

import {
  filterReaderSettingConflicts,
  overriddenStateKeys,
  promotableRows,
  toggleVisibleConflictSelection,
  type ReaderSettingConflict,
} from "../src/pages/reader/reader-settings-scope.ts";

const conflicts: ReaderSettingConflict[] = [
  { id: "a", title: "设计中的设计", author: "原研哉", conflicting_keys: ["font", "font_size"] },
  { id: "b", title: "The Sense of Style", author: "Steven Pinker", conflicting_keys: ["text_justification"] },
  { id: "c", title: "海边的卡夫卡", author: "村上春树", conflicting_keys: ["font"] },
];

test("row existence identifies overrides while unrelated book settings are ignored", () => {
  assert.deepEqual(
    overriddenStateKeys({ font: "system", margins: "0", toc_expanded: "[]" }),
    ["font", "margins"],
  );
});

test("only settings with a global counterpart are promotable", () => {
  assert.deepEqual(
    promotableRows({ font: "literata", show_lookup_markers: "false", reading_mode: "paginated" }),
    ["font", "reading_mode"],
  );
});

test("conflict search matches title and author without losing the source array", () => {
  assert.deepEqual(filterReaderSettingConflicts(conflicts, "pinker").map((book) => book.id), ["b"]);
  assert.deepEqual(filterReaderSettingConflicts(conflicts, "村上").map((book) => book.id), ["c"]);
  assert.equal(conflicts.length, 3);
});

test("bulk selection applies only to visible results and preserves cross-search choices", () => {
  const initial = new Set(["a"]);
  const selected = toggleVisibleConflictSelection(initial, [conflicts[1], conflicts[2]]);
  assert.deepEqual([...selected].sort(), ["a", "b", "c"]);

  const clearedVisible = toggleVisibleConflictSelection(selected, [conflicts[1], conflicts[2]]);
  assert.deepEqual([...clearedVisible], ["a"]);
});
