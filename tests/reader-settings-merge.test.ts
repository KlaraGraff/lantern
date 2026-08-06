import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  getReaderCapabilities,
  getReaderFontOptions,
  setCustomReaderFonts,
} from "../src/components/reader-settings.ts";
import { resolveReaderSettings } from "../src/pages/reader/useReaderSettingsSync.ts";

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
  textJustification: false,
  paragraphSpacing: "original",
  firstLineIndent: false,
  margins: 0,
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
  showMasteredMarkers: false,
  chapterEndReviewHint: true,
};

// `perBook` is a `book_settings` row set: the row existing is the override. The
// per-book localStorage blob it replaced is gone — there is no third source.
function merge(
  global: Record<string, string> = {},
  perBook: Record<string, string> = {},
) {
  return resolveReaderSettings(previous, global, perBook);
}

// Every key that lives in `book_settings`, with a row value that differs from both
// the global counterpart below and from `previous`.
const perBookRows = {
  theme: "original",
  font: "georgia",
  font_size: "40",
  line_spacing: "2.4",
  word_spacing: "9",
  char_spacing: "7",
  text_justification: "true",
  paragraph_spacing: "comfortable",
  first_line_indent: "true",
  reading_mode: "paginated",
  page_columns: "1",
  margins: "24",
  show_lookup_markers: "false",
  show_new_vocab_markers: "false",
  show_learning_markers: "false",
  show_mastered_markers: "true",
} as const;

const perBookExpectations: Record<keyof typeof perBookRows, unknown> = {
  theme: "original",
  font: "georgia",
  font_size: 40,
  line_spacing: 2.4,
  word_spacing: 9,
  char_spacing: 7,
  text_justification: true,
  paragraph_spacing: "comfortable",
  first_line_indent: true,
  reading_mode: "paginated",
  page_columns: 1,
  margins: 24,
  show_lookup_markers: false,
  show_new_vocab_markers: false,
  show_learning_markers: false,
  show_mastered_markers: true,
};

const perBookStateFields: Record<keyof typeof perBookRows, keyof ReaderSettingsState> = {
  theme: "theme",
  font: "font",
  font_size: "fontSize",
  line_spacing: "lineSpacing",
  word_spacing: "wordSpacing",
  char_spacing: "charSpacing",
  text_justification: "textJustification",
  paragraph_spacing: "paragraphSpacing",
  first_line_indent: "firstLineIndent",
  reading_mode: "readingMode",
  page_columns: "pageColumns",
  margins: "margins",
  show_lookup_markers: "showLookupMarkers",
  show_new_vocab_markers: "showNewVocabMarkers",
  show_learning_markers: "showLearningMarkers",
  show_mastered_markers: "showMasteredMarkers",
};

// The global values the rows above must beat. The last four keys have no global
// counterpart at all, which is exactly why they moved into `book_settings`.
const globalCounterparts = {
  reader_theme: "dark",
  font_family: "palatino",
  font_size: "18",
  line_spacing: "1.5",
  word_spacing: "3",
  char_spacing: "2",
  text_justification: "false",
  paragraph_spacing: "compact",
  first_line_indent: "false",
  reading_mode: "scrolling",
  page_columns: "2",
  margins: "6",
};

test("a book without a recorded theme override follows the global theme", () => {
  assert.equal(merge({ reader_theme: "dark" }).theme, "dark");
});

test("a theme picked in the reader panel wins over the global theme", () => {
  assert.equal(merge({ reader_theme: "dark" }, { theme: "original" }).theme, "original");
});

test("the theme override does not drag the other typography keys with it", () => {
  const merged = merge({ reader_theme: "dark", font_size: "18" }, { theme: "original" });
  assert.equal(merged.theme, "original");
  assert.equal(merged.fontSize, 18);
});

test("with neither a per-book row nor a global value the theme stays put", () => {
  assert.equal(merge().theme, previous.theme);
});

test("a book with no rows at all follows every global typography setting", () => {
  const merged = merge(globalCounterparts);
  assert.equal(merged.theme, "dark");
  assert.equal(merged.font, "palatino");
  assert.equal(merged.fontSize, 18);
  assert.equal(merged.lineSpacing, 1.5);
  assert.equal(merged.wordSpacing, 3);
  assert.equal(merged.textJustification, false);
  assert.equal(merged.paragraphSpacing, "compact");
  assert.equal(merged.firstLineIndent, false);
});

test("each per-book row overrides its global counterpart on its own", () => {
  const merged = merge(
    { font_size: "18", line_spacing: "1.5", word_spacing: "3" },
    { font_size: "40", word_spacing: "9" },
  );
  assert.equal(merged.fontSize, 40);
  assert.equal(merged.lineSpacing, 1.5);
  assert.equal(merged.wordSpacing, 9);
});

// P2.4 deliberately makes reading mode and page layout overridable while page
// turn animation stays global muscle-memory behavior.
test("book layout rows override global layout without capturing page-turn animation", () => {
  const merged = merge(
    { page_columns: "2", reading_mode: "scrolling", page_turn_animation: "fade" },
    { page_columns: "1", reading_mode: "paginated", page_turn_animation: "none" },
  );
  assert.equal(merged.pageColumns, 1);
  assert.equal(merged.readingMode, "paginated");
  assert.equal(merged.pageTurnAnimation, "fade");
});

test("a per-book row cannot freeze the progress toggles", () => {
  const merged = merge(
    {
      show_chapter_progress: "false",
      show_book_progress: "true",
      show_page_numbers: "false",
    },
    {
      show_chapter_progress: "true",
      show_book_progress: "false",
      show_page_numbers: "true",
    },
  );
  assert.equal(merged.showChapterProgress, false);
  assert.equal(merged.showBookProgress, true);
  assert.equal(merged.showPageNumbers, false);
});

test("a per-book row cannot freeze the page-turn bindings", () => {
  const merged = merge(
    { previous_page_binding: "mouse:left", next_page_binding: "mouse:right" },
    { previous_page_binding: "key:PageUp", next_page_binding: "key:PageDown" },
  );
  assert.equal(merged.previousPageBinding, "mouse:left");
  assert.equal(merged.nextPageBinding, "mouse:right");
});

test("new layout overrides work while global-only behavior ignores stray rows", () => {
  const merged = merge({}, {
    page_columns: "1",
    reading_mode: "paginated",
    page_turn_animation: "none",
    show_chapter_progress: "false",
    show_book_progress: "true",
    show_page_numbers: "true",
    previous_page_binding: "key:PageUp",
    next_page_binding: "key:PageDown",
    margins: "24",
  });
  assert.equal(merged.pageColumns, 1);
  assert.equal(merged.readingMode, "paginated");
  assert.equal(merged.pageTurnAnimation, previous.pageTurnAnimation);
  assert.equal(merged.showChapterProgress, previous.showChapterProgress);
  assert.equal(merged.showBookProgress, previous.showBookProgress);
  assert.equal(merged.showPageNumbers, previous.showPageNumbers);
  assert.equal(merged.previousPageBinding, previous.previousPageBinding);
  assert.equal(merged.nextPageBinding, previous.nextPageBinding);
  assert.equal(merged.margins, 24);
});

test("char spacing and the marker toggles come from per-book rows", () => {
  // The reader state with no global counterpart at all: a row is its only storage
  // now that the localStorage blob is gone.
  const merged = merge({ page_columns: "1" }, {
    char_spacing: "7",
    show_lookup_markers: "false",
    show_new_vocab_markers: "false",
    show_learning_markers: "false",
    show_mastered_markers: "true",
  });
  assert.equal(merged.charSpacing, 7);
  assert.equal(merged.showLookupMarkers, false);
  assert.equal(merged.showNewVocabMarkers, false);
  assert.equal(merged.showLearningMarkers, false);
  assert.equal(merged.showMasteredMarkers, true);
});

test("marker toggles resolve per-book, then global, then the canonical default", () => {
  // The global layer was added after the per-book rows, so the case that has to
  // stay byte-identical is the one every existing install upgrades into: no
  // global row at all must land on exactly the old hardcoded defaults.
  const noGlobal = resolveReaderSettings(previous, {}, {});
  assert.equal(noGlobal.showLookupMarkers, true);
  assert.equal(noGlobal.showNewVocabMarkers, true);
  assert.equal(noGlobal.showLearningMarkers, true);
  assert.equal(noGlobal.showMasteredMarkers, false);

  const globalOnly = resolveReaderSettings(previous, {
    show_lookup_markers: "false",
    show_mastered_markers: "true",
  }, {});
  assert.equal(globalOnly.showLookupMarkers, false);
  assert.equal(globalOnly.showMasteredMarkers, true);
  // Untouched globally, so still the default rather than the sibling's value.
  assert.equal(globalOnly.showLearningMarkers, true);

  const bookWins = resolveReaderSettings(
    previous,
    { show_lookup_markers: "false" },
    { show_lookup_markers: "true" },
  );
  assert.equal(bookWins.showLookupMarkers, true);
});

test("marker settings without rows return to canonical defaults instead of leaking from another book", () => {
  const pollutedPrevious = {
    ...previous,
    showLookupMarkers: false,
    showNewVocabMarkers: false,
    showLearningMarkers: false,
    showMasteredMarkers: true,
  };
  const merged = resolveReaderSettings(pollutedPrevious, {}, {});
  assert.equal(merged.showLookupMarkers, true);
  assert.equal(merged.showNewVocabMarkers, true);
  assert.equal(merged.showLearningMarkers, true);
  assert.equal(merged.showMasteredMarkers, false);
});

// The per-book guarantee, one key at a time: book A's row must not reach book B,
// and book B having no row must leave the previous value standing.
for (const [key, expected] of Object.entries(perBookExpectations)) {
  const rowKey = key as keyof typeof perBookRows;
  const field = perBookStateFields[rowKey];

  test(`${key} is per-book: a row on book A does not reach book B`, () => {
    const bookA = merge(globalCounterparts, { [rowKey]: perBookRows[rowKey] });
    const bookB = merge(globalCounterparts, {});
    assert.equal(bookA[field], expected);
    assert.notEqual(bookB[field], expected);
  });

  test(`${key} without a row leaves the previous value standing`, () => {
    // No global counterpart either, so the merge has nothing but `previous` left.
    assert.equal(merge()[field], previous[field]);
  });
}

test("customTheme is global-first, so it needs no per-book override", () => {
  const merged = merge(
    { reader_custom_theme: JSON.stringify({ color: "#AABBCC", opacity: 40 }) },
    { theme: "original", reader_custom_theme: JSON.stringify({ color: "#112233", opacity: 10 }) },
  );
  assert.deepEqual(merged.customTheme, { color: "#AABBCC", opacity: 40 });
});

test("an unknown font id falls back to the system font", () => {
  assert.equal(merge({}, { font: "no-such-font" }).font, "system");
  assert.equal(merge({ font_family: "no-such-font" }).font, "system");
});

test("a registered custom font survives the merge", (t) => {
  setCustomReaderFonts([
    { id: "custom-abc", family_name: "My Face", file_path: "/tmp/my-face.ttf" },
  ]);
  t.after(() => setCustomReaderFonts([]));
  assert.equal(merge({}, { font: "custom-abc" }).font, "custom-abc");
  assert.equal(merge({ font_family: "custom-abc" }).font, "custom-abc");
});

test("a custom font that is no longer registered falls back to the system font", () => {
  setCustomReaderFonts([]);
  assert.equal(merge({}, { font: "custom-abc" }).font, "system");
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

test("fixed-layout EPUB hides controls that cannot affect its renderer", () => {
  const capabilities = getReaderCapabilities("epub", "pre-paginated");
  assert.equal(capabilities.supportsReflowSettings, false);
  assert.equal(capabilities.supportsContinuousScroll, false);
  assert.equal(capabilities.supportsSpread, false);
  assert.equal(capabilities.supportsSelection, true);
});

test("rendition layout does not downgrade PDF, text, or reflowable EPUB", () => {
  assert.equal(getReaderCapabilities("pdf", "pre-paginated").supportsZoom, true);
  assert.equal(getReaderCapabilities("text", "pre-paginated").supportsReflowSettings, true);
  assert.equal(getReaderCapabilities("epub", "reflowable").supportsReflowSettings, true);
  assert.equal(getReaderCapabilities("epub").supportsReflowSettings, true);
});
