import assert from "node:assert/strict";
import test from "node:test";

import {
  currentPositionIndex,
  filterMarkRows,
  mergeMarkRows,
  readerNoteDraftKey,
  sortMarkRows,
  type CompareLocation,
  type MarkRow,
  type ReaderNote,
} from "../src/components/reader-mark-rows.ts";
import type { Highlight } from "../src/hooks/useBookmarks.ts";
import type { AutoHighlight } from "../src/hooks/useAutoHighlights.ts";

/**
 * The reader's 笔记 panel is one column holding what used to be three tabs.
 * The rules under test are product rulings, not conveniences: the column is
 * ordered by where things sit in the book rather than when they were made,
 * bookmarks and highlights share it rather than splitting it, looked-up words
 * are not in it at all, and an anchor the engine cannot place is parked at the
 * bottom instead of being guessed into the middle.
 *
 * Locations here are `cfi-<n>`, ordered by that number — a stand-in for the
 * real comparator, which lives in foliate's epubcfi module.
 */
const compare: CompareLocation = (left, right) => {
  const place = (value: string) => Number(value.replace("cfi-", ""));
  const [a, b] = [place(left), place(right)];
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a - b;
};

function highlight(id: string, at: number, updatedAt = 100, text = "drawn"): Highlight {
  return {
    id,
    book_id: "book",
    cfi_range: `cfi-${at}`,
    color: "yellow",
    text_content: text,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function note(
  id: string,
  anchorKind: string,
  at: number | null,
  content: string,
  updatedAt = 100,
): ReaderNote {
  return {
    id,
    book_id: "book",
    anchor_kind: anchorKind,
    normalized_word: anchorKind === "word" ? "courage" : null,
    scope: "book",
    location: at === null ? null : `cfi-${at}`,
    selected_text: anchorKind === "selection" ? "quoted" : null,
    content,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function auto(anchor: string, at: number, overrides: Partial<AutoHighlight> = {}): AutoHighlight {
  return {
    anchor,
    book_id: "book",
    cfi: `cfi-${at}`,
    text: "derived",
    source: "lookup",
    label: null,
    created_at: 100,
    ...overrides,
  };
}

const keys = (rows: readonly MarkRow[]) => rows.map((row) => row.key);
const ordered = (rows: readonly MarkRow[]) => keys(sortMarkRows(rows, compare));

test("draft keys isolate books, saved notes, and unsaved anchors", () => {
  const anchor = { anchorKind: "selection" as const, location: "epubcfi(/6/4)", selectedText: "Quote" };
  assert.notEqual(readerNoteDraftKey("book-a", "note-1", anchor), readerNoteDraftKey("book-b", "note-1", anchor));
  assert.notEqual(readerNoteDraftKey("book-a", "note-1", anchor), readerNoteDraftKey("book-a", "note-2", anchor));
  assert.notEqual(
    readerNoteDraftKey("book-a", null, anchor),
    readerNoteDraftKey("book-a", null, { ...anchor, location: "epubcfi(/6/6)" }),
  );
});

test("a kept place and a highlight share one column, ordered by the book", () => {
  const rows = mergeMarkRows(
    [highlight("h1", 30), highlight("h2", 10)],
    [note("n1", "position", 20, ""), note("n2", "position", 40, "why I stopped")],
    [],
  );
  assert.deepEqual(ordered(rows), ["h:h2", "p:n1", "h:h1", "p:n2"]);
});

test("nothing written on it is not a category — an empty bookmark is a row like any other", () => {
  const rows = mergeMarkRows([], [note("n1", "position", 10, "")], []);
  assert.deepEqual(keys(rows), ["p:n1"]);
  assert.equal(rows[0].kind, "position");
});

test("a note at a highlight's anchor is the same row, not a second one", () => {
  const rows = mergeMarkRows([highlight("h1", 10)], [note("n1", "selection", 10, "my thought")], []);
  assert.deepEqual(keys(rows), ["h:h1"]);
  const row = rows[0];
  assert.equal(row.kind === "highlight" && row.note?.content, "my thought");
});

test("only the newest note speaks for an anchor; the older one keeps its own row", () => {
  const rows = mergeMarkRows(
    [highlight("h1", 10)],
    [note("n1", "selection", 10, "older", 100), note("n2", "selection", 10, "newer", 200)],
    [],
  );
  assert.deepEqual(keys(rows), ["h:h1", "n:n1"]);
  const row = rows[0];
  assert.equal(row.kind === "highlight" && row.note?.id, "n2");
});

test("looked-up words never appear here — they live on the vocabulary page", () => {
  const rows = mergeMarkRows([], [note("n1", "word", 10, "a gloss"), note("n2", "selection", 20, "kept")], []);
  assert.deepEqual(keys(rows), ["n:n2"]);
});

test("an anchor the engine cannot place sinks to the bottom rather than guessing", () => {
  const rows = mergeMarkRows(
    [highlight("h1", 20)],
    [note("n1", "position", null, "unplaceable", 300), note("n2", "position", 10, "placed")],
    [],
  );
  assert.deepEqual(ordered(rows), ["p:n2", "h:h1", "p:n1"]);
});

test("rows at one spot fall back to newest-first, and the order is stable", () => {
  const rows = mergeMarkRows(
    [],
    [note("n1", "position", 10, "older", 100), note("n2", "position", 10, "newer", 200)],
    [],
  );
  assert.deepEqual(ordered(rows), ["p:n2", "p:n1"]);
  assert.deepEqual(ordered(rows), ordered(mergeMarkRows([], [note("n2", "position", 10, "newer", 200), note("n1", "position", 10, "older", 100)], [])));
});

test("automatic highlights keep a place in the column", () => {
  const rows = mergeMarkRows([highlight("h1", 30)], [], [auto("lookup:a", 10)]);
  assert.deepEqual(ordered(rows), ["a:lookup:a", "h:h1"]);
});

test("「你现在读到这里」 divides the list, and never at either end", () => {
  const rows = sortMarkRows(
    mergeMarkRows([highlight("h1", 10), highlight("h2", 30)], [note("n1", "position", 50, "")], []),
    compare,
  );
  assert.equal(currentPositionIndex(rows, "cfi-20", compare), 1);
  assert.equal(currentPositionIndex(rows, "cfi-30", compare), 1, "the row you are standing on is ahead of you");
  assert.equal(currentPositionIndex(rows, "cfi-5", compare), null, "nothing behind you is nothing to divide");
  assert.equal(currentPositionIndex(rows, "cfi-99", compare), null);
  assert.equal(currentPositionIndex(rows, null, compare), null);
  assert.equal(currentPositionIndex(rows, "somewhere-else", compare), null, "an unplaceable position draws no line");
});

test("search reads the passage and what was written on it, and only narrows", () => {
  const rows = mergeMarkRows(
    [highlight("h1", 10, 100, "a drawn passage")],
    [note("n1", "position", 20, "the thought I had here")],
    [auto("lookup:a", 30, { text: "He admired her resolve.", label: "steadfastness" })],
  );
  assert.deepEqual(keys(filterMarkRows(rows, "DRAWN")), ["h:h1"]);
  assert.deepEqual(keys(filterMarkRows(rows, "thought")), ["p:n1"]);
  assert.deepEqual(keys(filterMarkRows(rows, "steadfast")), ["a:lookup:a"]);
  assert.deepEqual(keys(filterMarkRows(rows, "   ")), keys(rows));
  assert.deepEqual(keys(filterMarkRows(rows, "nothing like this")), []);
});

test("a bookmark with nothing written on it is still findable by where it sits", () => {
  const rows = mergeMarkRows([], [note("n1", "position", 10, "")], []);
  assert.deepEqual(keys(filterMarkRows(rows, "")), ["p:n1"]);
  assert.deepEqual(keys(filterMarkRows(rows, "anything")), []);
});
