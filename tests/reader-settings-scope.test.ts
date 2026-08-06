import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  diffBookOverrides,
  filterReaderSettingConflicts,
  isPendingUndoActionable,
  isPromotionUndoable,
  overriddenStateKeys,
  perBookOverrideKeys,
  perBookSettingKeys,
  promotableBookSettingKeys,
  promotableRows,
  promotionOtherBookCount,
  promotionToastLabel,
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
  // `show_lookup_markers` has a global layer now, so it promotes with the rest.
  // `toc_expanded` is a `book_settings` row that is not a reader setting at all
  // — it has no global counterpart and never gains one, so it stays filtered.
  assert.deepEqual(
    promotableRows({
      font: "literata",
      show_lookup_markers: "false",
      reading_mode: "paginated",
      toc_expanded: "[]",
    }),
    ["font", "reading_mode", "show_lookup_markers"],
  );
});

test("every per-book reader setting can be promoted", () => {
  // The button vanishing for a book whose only overrides were marker toggles is
  // exactly the bug the global layer was built to fix; a key added to the
  // per-book set without a global counterpart would bring it straight back.
  const promotable = new Set<string>(promotableBookSettingKeys);
  for (const key of perBookOverrideKeys) {
    assert.ok(
      promotable.has(perBookSettingKeys[key]),
      `${perBookSettingKeys[key]} has no global counterpart, so it cannot be promoted`,
    );
  }
});

test("a promotion that displaced nothing offers no undo", () => {
  assert.equal(isPromotionUndoable(null), false);
  assert.equal(isPromotionUndoable({ globals: {}, book_settings: [] }), false);
  // A displaced global with no prior row is still undoable — the undo deletes it.
  assert.equal(
    isPromotionUndoable({ globals: { show_lookup_markers: null }, book_settings: [] }),
    true,
  );
  assert.equal(
    isPromotionUndoable({
      globals: {},
      book_settings: [{ book_id: "a", key: "font", value: "literata" }],
    }),
    true,
  );
});

// A stand-in for i18next: returns the key so the assertions read as structure
// rather than as pinned Chinese copy, and interpolates `count` the same way.
const fakeT = (key: string, options?: { count: number }) => (
  options === undefined ? key : `${key}=${options.count}`
);

const promotionUndo = (books: [string, string][]) => ({
  globals: { font_family: "georgia" },
  book_settings: books.map(([book_id, key]) => ({ book_id, key, value: "x" })),
});

test("the promote toast counts books, not the rows it took from them", () => {
  // Two rows off one book is still one book, and the source book never counts:
  // its rows went away without a single value it renders moving.
  assert.equal(
    promotionOtherBookCount(
      promotionUndo([["source", "font"], ["b", "font"], ["b", "font_size"], ["c", "font"]]),
      "source",
    ),
    2,
  );
  assert.equal(promotionOtherBookCount(null, "source"), 0);
});

test("the promote toast drops the reach clause when no other book moved", () => {
  // "0 本书跟着变了" reads as a failure. The plain label is the honest one.
  assert.equal(
    promotionToastLabel(promotionUndo([["source", "font"]]), "source", fakeT),
    "readerSettings.scope.promoted",
  );
  assert.equal(
    promotionToastLabel({ globals: { font_family: "georgia" }, book_settings: [] }, "source", fakeT),
    "readerSettings.scope.promoted",
  );
});

test("the promote toast reports its reach when other books moved", () => {
  assert.equal(
    promotionToastLabel(promotionUndo([["source", "font"], ["b", "font"], ["c", "font"]]), "source", fakeT),
    "readerSettings.scope.promoted · readerSettings.scope.promotedBooks=2",
  );
});

test("an undo slot that would put nothing back offers no affordance", () => {
  assert.equal(isPendingUndoActionable(null), false);
  assert.equal(isPendingUndoActionable({ kind: "restore", label: "l", values: {} }), false);
  assert.equal(
    isPendingUndoActionable({ kind: "restore", label: "l", values: { font: "literata" } }),
    true,
  );
  assert.equal(
    isPendingUndoActionable({
      kind: "promote",
      label: "l",
      undo: { globals: {}, book_settings: [] },
    }),
    false,
  );
  assert.equal(
    isPendingUndoActionable({
      kind: "promote",
      label: "l",
      undo: promotionUndo([["source", "show_lookup_markers"]]),
    }),
    true,
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

// A minimal-but-complete state fixture for `diffBookOverrides`. Only
// `textJustification` and `margins` vary across the tests below; everything
// else exists just so the object satisfies `ReaderSettingsState`.
const baseState: ReaderSettingsState = {
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
  margins: 4,
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
  showMasteredMarkers: false,
  chapterEndReviewHint: true,
  bookFinishedHint: true,
};

test("a value set away from global writes an override row", () => {
  const global = baseState;
  const previous = baseState;
  const next: ReaderSettingsState = { ...baseState, textJustification: true };
  const { toWrite, toDelete } = diffBookOverrides(previous, next, global, {});
  assert.deepEqual(toWrite, { text_justification: "true" });
  assert.deepEqual(toDelete, []);
});

test("setting an overridden value back to the global value clears the override instead of storing a copy", () => {
  // The book currently overrides justification to `true`; global is `false`.
  const global = baseState;
  const previous: ReaderSettingsState = { ...baseState, textJustification: true };
  const next: ReaderSettingsState = { ...baseState, textJustification: false };
  const currentOverrides = { text_justification: "true" };
  const { toWrite, toDelete } = diffBookOverrides(previous, next, global, currentOverrides);
  assert.deepEqual(toWrite, {});
  assert.deepEqual(toDelete, ["text_justification"]);
});

test("a value that already matches global and has no override writes and deletes nothing", () => {
  const global = baseState;
  const previous = baseState;
  const next = baseState;
  const { toWrite, toDelete } = diffBookOverrides(previous, next, global, {});
  assert.deepEqual(toWrite, {});
  assert.deepEqual(toDelete, []);
});

test("only the keys that actually changed are diffed, even when others already equal global", () => {
  const global = baseState;
  const previous: ReaderSettingsState = { ...baseState, margins: 10 };
  const next: ReaderSettingsState = { ...baseState, margins: 4 };
  const currentOverrides = { margins: "10" };
  const { toWrite, toDelete } = diffBookOverrides(previous, next, global, currentOverrides);
  assert.deepEqual(toWrite, {});
  assert.deepEqual(toDelete, ["margins"]);
});
