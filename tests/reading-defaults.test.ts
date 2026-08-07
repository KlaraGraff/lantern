import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  READING_DEFAULT_SETTING_KEYS,
  buildReadingDefaultSettings,
} from "../src/components/settings/reading-defaults.ts";
import type { ReaderSettingsState } from "../src/components/ReaderSettings";

// A stand-in for `createDefaultReaderSettings()`, which reads the document to
// pick its theme and so cannot run here. Every value is deliberately unlike the
// real default, so a mapping that ignored its argument and hard-coded a value
// would fail loudly.
const defaults = {
  theme: "sepia",
  customTheme: { background: "#ffffff", text: "#111111" },
  font: "palatino",
  fontSize: 26,
  narrowFontShrink: true,
  readingMode: "scrolling",
  pageColumns: 2,
  pageTurnAnimation: "slide",
  showChapterProgress: true,
  showBookProgress: false,
  showPageNumbers: false,
  previousPageBinding: "ArrowLeft",
  nextPageBinding: "ArrowRight",
  lineSpacing: 1.8,
  charSpacing: 0,
  wordSpacing: 0,
  textJustification: false,
  paragraphSpacing: "original",
  firstLineIndent: false,
  margins: 0,
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
} as unknown as ReaderSettingsState;

test("the reset writes every global reading key and nothing else", () => {
  const rows = buildReadingDefaultSettings(defaults);
  assert.deepEqual(Object.keys(rows).sort(), [...READING_DEFAULT_SETTING_KEYS].sort());
  // The `settings` table is string-valued: a stray number or boolean would be
  // written as-is by the Tauri command and read back wrong.
  for (const [key, value] of Object.entries(rows)) {
    assert.equal(typeof value, "string", `${key} is not a string`);
  }
});

test("the values come from the reader's own defaults, not a second table", () => {
  const rows = buildReadingDefaultSettings(defaults);
  assert.equal(rows.font_size, "26");
  assert.equal(rows.reader_theme, "sepia");
  assert.equal(rows.line_spacing, "1.8");
  assert.equal(rows.narrow_font_shrink, "true");
  assert.equal(rows.show_book_progress, "false");
  assert.equal(rows.page_columns, "2");
  assert.equal(rows.reader_custom_theme, JSON.stringify(defaults.customTheme));

  const changed = buildReadingDefaultSettings({ ...defaults, fontSize: 19, margins: 12 });
  assert.equal(changed.font_size, "19");
  assert.equal(changed.margins, "12");
});

test("per-book override keys stay out of the reset", () => {
  const rows = buildReadingDefaultSettings(defaults);
  // The marker toggles exist only as per-book rows — a global default for
  // them would be a setting the UI has no control for.
  for (const key of ["show_lookup_markers", "show_new_vocab_markers", "show_learning_markers"]) {
    assert.ok(!(key in rows), `${key} should not be reset globally`);
  }
});

test("no row in the Reading section saves a key the reset forgets", () => {
  // Source scan rather than a render: the drift this guards against is someone
  // adding a row months from now, and the reset silently not covering it.
  const source = readFileSync(new URL("../src/components/settings/ReadingSettings.tsx", import.meta.url), "utf8");
  const saved = new Set(
    Array.from(source.matchAll(/\bsave\("([a-z_]+)"/g), (match) => match[1]),
  );
  const covered = new Set<string>(READING_DEFAULT_SETTING_KEYS);
  for (const key of saved) {
    assert.ok(covered.has(key), `ReadingSettings saves "${key}" but the reset does not restore it`);
  }
  // And nothing in the reset list has quietly left the section.
  for (const key of covered) {
    assert.ok(source.includes(key), `"${key}" is reset but no longer appears in ReadingSettings`);
  }
});
