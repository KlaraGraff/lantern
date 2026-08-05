import assert from "node:assert/strict";
import test from "node:test";

import {
  groupsHoldingUncommittedNumber,
  READING_NUMBER_ROWS,
  READING_REHYDRATION_GROUPS,
  READING_REHYDRATION_KEYS,
  sameNumberValue,
} from "../src/components/settings/reading-rehydration.ts";
import { READING_DEFAULT_SETTING_KEYS } from "../src/components/settings/reading-defaults.ts";
import { groupsToRehydrate } from "../src/components/settings/settings-rehydration.ts";

const applied = {
  font_size: "26",
  line_spacing: "1.8",
  char_spacing: "0",
  word_spacing: "0",
  margins: "6",
};

test("every row the pane writes belongs to exactly one group", () => {
  assert.deepEqual(
    [...READING_REHYDRATION_KEYS].sort(),
    [...READING_DEFAULT_SETTING_KEYS].sort(),
  );
  assert.equal(new Set(READING_REHYDRATION_KEYS).size, READING_REHYDRATION_KEYS.length);
});

test("each number row is a group of its own", () => {
  // The whole point of the split: digits half-typed into font size must not
  // hold back a margin change arriving from the reader window.
  for (const row of READING_NUMBER_ROWS) {
    const group = READING_REHYDRATION_GROUPS.find((candidate) => candidate.id === row.groupId);
    assert.ok(group, `no group ${row.groupId}`);
    assert.deepEqual([...group.keys], [row.key]);
  }
});

test("nothing is held back while no number input has focus", () => {
  assert.deepEqual(
    groupsHoldingUncommittedNumber({ focusedKey: null, values: { font_size: "1" }, applied }),
    [],
  );
});

test("the focused row is held back once its digits differ from what was written", () => {
  assert.deepEqual(
    groupsHoldingUncommittedNumber({
      focusedKey: "font_size",
      values: { ...applied, font_size: "1" },
      applied,
    }),
    ["fontSize"],
  );
});

test("focus on its own holds nothing back", () => {
  // Tabbing through a row must not freeze it: there is nothing on screen that
  // the store would overwrite.
  assert.deepEqual(
    groupsHoldingUncommittedNumber({ focusedKey: "font_size", values: { ...applied }, applied }),
    [],
  );
});

test("typing the old value back releases the row", () => {
  const typing = groupsHoldingUncommittedNumber({
    focusedKey: "margins",
    values: { ...applied, margins: "1" },
    applied,
  });
  assert.deepEqual(typing, ["margins"]);
  assert.deepEqual(
    groupsHoldingUncommittedNumber({ focusedKey: "margins", values: { ...applied }, applied }),
    [],
  );
});

test("a key with no stored row yet counts as uncommitted", () => {
  assert.deepEqual(
    groupsHoldingUncommittedNumber({
      focusedKey: "line_spacing",
      values: { line_spacing: "2" },
      applied: {},
    }),
    ["lineSpacing"],
  );
});

test("a focused control that is not a number row holds nothing back", () => {
  assert.deepEqual(
    groupsHoldingUncommittedNumber({ focusedKey: "font_family", values: {}, applied }),
    [],
  );
});

test("the same number written two ways is not a draft", () => {
  assert.equal(sameNumberValue("1.8", "1.80"), true);
  assert.equal(sameNumberValue("6", "6"), true);
  assert.equal(sameNumberValue("6", "7"), false);
  assert.equal(sameNumberValue(undefined, undefined), true);
  assert.equal(sameNumberValue("6", undefined), false);
  // An empty box is not "zero, unchanged" — it is a value the user is part-way
  // through replacing.
  assert.equal(sameNumberValue("", "0"), false);
  assert.equal(sameNumberValue("nonsense", "0"), false);
  assert.deepEqual(
    groupsHoldingUncommittedNumber({
      focusedKey: "line_spacing",
      values: { line_spacing: "1.8" },
      applied: { line_spacing: "1.80" },
    }),
    [],
  );
});

test("typing in font size lets a margin change from another window through", () => {
  const stored = { ...applied, margins: "12", font_size: "40" };
  const stale = groupsToRehydrate({
    groups: READING_REHYDRATION_GROUPS,
    stored,
    applied,
    pending: [],
    blocked: groupsHoldingUncommittedNumber({
      focusedKey: "font_size",
      values: { ...applied, font_size: "1" },
      applied,
    }),
  });
  assert.deepEqual(stale, ["margins"]);
  // And once the caret leaves font size — the blur that writes the digits — the
  // group it was holding is free again.
  assert.deepEqual(
    groupsToRehydrate({
      groups: READING_REHYDRATION_GROUPS,
      stored,
      applied,
      pending: [],
      blocked: groupsHoldingUncommittedNumber({ focusedKey: null, values: applied, applied }),
    }),
    ["fontSize", "margins"],
  );
});
