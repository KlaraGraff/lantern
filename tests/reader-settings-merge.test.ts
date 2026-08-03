import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  getReaderFontOptions,
  setCustomReaderFonts,
} from "../src/components/reader-settings.ts";
import {
  mergeStoredReaderSettings,
  type StoredReaderSettings,
} from "../src/pages/reader/useReaderSettingsSync.ts";

const previous: ReaderSettingsState = {
  theme: "paper",
  customTheme: { color: "#DDE8D8", opacity: 70 },
  font: "palatino",
  fontSize: 26,
  narrowFontShrink: true,
  readingMode: "scrolling",
  pageColumns: 2,
  pageTurnAnimation: "slide",
  showChapterProgress: true,
  showBookProgress: false,
  showPageNumbers: false,
  previousPageBinding: "key:ArrowLeft",
  nextPageBinding: "key:ArrowRight",
  lineSpacing: 1.8,
  charSpacing: 0,
  wordSpacing: 0,
  margins: 0,
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
  showMasteredMarkers: false,
};

// `perBook` is a `book_settings` row set: the row existing is the override.
function merge(
  stored: StoredReaderSettings,
  global: Record<string, string> = {},
  perBook: Record<string, string> = {},
) {
  return mergeStoredReaderSettings(previous, stored, global, perBook);
}

test("a book without a recorded theme override follows the global theme", () => {
  // The blob a pre-fix build wrote: every field snapshotted, no book_settings rows.
  const snapshot: StoredReaderSettings = { theme: "original", fontSize: 30 };
  assert.equal(merge(snapshot, { reader_theme: "dark" }).theme, "dark");
});

test("a theme picked in the reader panel wins over the global theme", () => {
  assert.equal(merge({}, { reader_theme: "dark" }, { theme: "original" }).theme, "original");
});

test("the theme override does not drag the other typography keys with it", () => {
  const merged = merge(
    { fontSize: 40 },
    { reader_theme: "dark", font_size: "18" },
    { theme: "original" },
  );
  assert.equal(merged.theme, "original");
  assert.equal(merged.fontSize, 18);
});

test("with neither a stored override nor a global value the theme stays put", () => {
  assert.equal(merge({}).theme, previous.theme);
});

test("a legacy localStorage blob no longer supplies any typography value", () => {
  const snapshot: StoredReaderSettings = {
    theme: "original",
    font: "custom-abc",
    fontSize: 40,
    lineSpacing: 2.4,
    wordSpacing: 9,
  };
  const merged = merge(snapshot, {
    reader_theme: "dark",
    font_family: "palatino",
    font_size: "18",
    line_spacing: "1.5",
    word_spacing: "3",
  });
  assert.equal(merged.theme, "dark");
  assert.equal(merged.font, "palatino");
  assert.equal(merged.fontSize, 18);
  assert.equal(merged.lineSpacing, 1.5);
  assert.equal(merged.wordSpacing, 3);
});

test("each per-book row overrides its global counterpart on its own", () => {
  const merged = merge(
    {},
    { font_size: "18", line_spacing: "1.5", word_spacing: "3" },
    { font_size: "40", word_spacing: "9" },
  );
  assert.equal(merged.fontSize, 40);
  assert.equal(merged.lineSpacing, 1.5);
  assert.equal(merged.wordSpacing, 9);
});

test("customTheme is global-first, so it needs no per-book override", () => {
  const stored: StoredReaderSettings = { customTheme: { color: "#112233", opacity: 10 } };
  const merged = merge(
    stored,
    { reader_custom_theme: JSON.stringify({ color: "#AABBCC", opacity: 40 }) },
    { theme: "original" },
  );
  assert.deepEqual(merged.customTheme, { color: "#AABBCC", opacity: 40 });
});

test("an unknown font id falls back to the system font", () => {
  assert.equal(merge({}, {}, { font: "no-such-font" }).font, "system");
  assert.equal(merge({}, { font_family: "no-such-font" }).font, "system");
});

test("a registered custom font survives the merge", (t) => {
  setCustomReaderFonts([
    { id: "custom-abc", family_name: "My Face", file_path: "/tmp/my-face.ttf" },
  ]);
  t.after(() => setCustomReaderFonts([]));
  assert.equal(merge({}, {}, { font: "custom-abc" }).font, "custom-abc");
  assert.equal(merge({}, { font_family: "custom-abc" }).font, "custom-abc");
});

test("a custom font that is no longer registered falls back to the system font", () => {
  setCustomReaderFonts([]);
  assert.equal(merge({}, {}, { font: "custom-abc" }).font, "system");
});

test("the font picker labels a selection that no registered font matches", () => {
  const options = getReaderFontOptions("custom-gone", "Unavailable font");
  const selected = options.find((option) => option.value === "custom-gone");
  assert.equal(selected?.label, "Unavailable font");
});

test("the font picker leaves a registered selection alone", (t) => {
  setCustomReaderFonts([
    { id: "custom-abc", family_name: "My Face", file_path: "/tmp/my-face.ttf" },
  ]);
  t.after(() => setCustomReaderFonts([]));
  const options = getReaderFontOptions("custom-abc", "Unavailable font");
  assert.deepEqual(
    options.filter((option) => option.value === "custom-abc"),
    [{ value: "custom-abc", label: "My Face" }],
  );
});
