import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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

// The same Enter commits single-line fields across the app — a new collection,
// an alias, a chat title, the display name, a book source. Each must leave the
// IME's Enter to the IME, or the half-typed pinyin is saved in place of the
// hanzi the reader was choosing.
const ENTER_COMMIT_SITES = [
  "src/components/BookContextMenu.tsx",
  "src/components/PersonAliasesSection.tsx",
  "src/components/AiPanel.tsx",
  "src/components/ChatDetailView.tsx",
  "src/components/settings/GeneralSettings.tsx",
  "src/components/settings/BookSourcesSettings.tsx",
];

test("fields that commit on Enter route it through the IME guard", () => {
  for (const file of ENTER_COMMIT_SITES) {
    const source = readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /\.key === "Enter"/, `${file} reads Enter without the IME guard`);
    assert.match(source, /isPaletteRowActivation\((e|event)\.nativeEvent\)/, file);
  }
});

test("the in-book chapter palette guards its Enter like the library palette", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "../src/components/command-palette/ReaderChapterPalette.tsx"),
    "utf8",
  );
  const start = source.indexOf('} else if (event.key === "Enter") {');
  const end = source.indexOf('} else if (event.key === "Escape") {', start);
  assert.ok(start >= 0 && end > start, "no Enter branch found in ReaderChapterPalette");
  assert.match(source.slice(start, end), /isPaletteRowActivation\(/);
});
