import test from "node:test";
import assert from "node:assert/strict";

import { nextRadioIndex } from "../src/components/ui/radio-group.ts";

test("both axes move, so no arrow key is dead in a card grid", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 3), 1);
  assert.equal(nextRadioIndex("ArrowDown", 0, 3), 1);
  assert.equal(nextRadioIndex("ArrowLeft", 2, 3), 1);
  assert.equal(nextRadioIndex("ArrowUp", 2, 3), 1);
});

test("movement wraps at both ends", () => {
  assert.equal(nextRadioIndex("ArrowRight", 2, 3), 0);
  assert.equal(nextRadioIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextRadioIndex("ArrowRight", 0, 1), 0);
});

test("Home and End jump to the ends", () => {
  assert.equal(nextRadioIndex("Home", 2, 3), 0);
  assert.equal(nextRadioIndex("End", 0, 3), 2);
});

test("keys the group does not own are left to the browser", () => {
  for (const key of ["Tab", "Enter", " ", "Escape", "a", "PageDown"]) {
    assert.equal(nextRadioIndex(key, 0, 3), null, `${key} should not move the selection`);
  }
});

test("a group with nothing in it never reports an index", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 0), null);
  assert.equal(nextRadioIndex("Home", 0, 0), null);
});

test("an unmatched selection still moves within the group", () => {
  // indexOf returns -1 when the stored value is not one of the options.
  assert.equal(nextRadioIndex("ArrowRight", -1, 3), 1);
  assert.equal(nextRadioIndex("ArrowLeft", -1, 3), 2);
  assert.equal(nextRadioIndex("ArrowRight", 9, 3), 1);
});
