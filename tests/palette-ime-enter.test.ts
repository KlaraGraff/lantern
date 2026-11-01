import assert from "node:assert/strict";
import test from "node:test";

import { isPaletteRowActivation } from "../src/components/command-palette/palette-model.ts";

const press = (overrides: Partial<{ key: string; isComposing: boolean; keyCode: number }> = {}) => ({
  key: "Enter",
  isComposing: false,
  keyCode: 13,
  ...overrides,
});

test("the Enter that accepts an IME candidate never runs the selected row", () => {
  // A Chinese reader types pinyin into ⌘K and presses Enter to take the hanzi.
  // That keydown is the same `key` as "open the selected result", so without
  // this guard the palette closes and opens a book the reader never chose.
  assert.equal(isPaletteRowActivation(press({ isComposing: true })), false);
  // WebKit reports isComposing = false on that same event and leaves keyCode
  // 229 as the only signal.
  assert.equal(isPaletteRowActivation(press({ keyCode: 229 })), false);
  assert.equal(isPaletteRowActivation(press({ isComposing: true, keyCode: 229 })), false);
});

test("a real Enter still runs the selected row", () => {
  assert.equal(isPaletteRowActivation(press()), true);
  assert.equal(isPaletteRowActivation(press({ keyCode: 0 })), true);
});

test("no other key runs a row", () => {
  for (const key of ["a", "Escape", "Tab", "ArrowDown", "NumpadEnter"]) {
    assert.equal(isPaletteRowActivation(press({ key })), false, key);
  }
});
