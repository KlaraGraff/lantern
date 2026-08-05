import assert from "node:assert/strict";
import test from "node:test";

import {
  isNotesTruncated,
  layoutReaderRailNotes,
  readerNoteDraftKey,
  readerNotePageNumber,
  resolveReaderNoteEditorStatus,
} from "../src/components/reader-notes-rail.ts";

test("draft keys isolate books, saved notes, and unsaved anchors", () => {
  const anchor = { anchorKind: "selection" as const, location: "epubcfi(/6/4)", selectedText: "Quote" };
  assert.notEqual(readerNoteDraftKey("book-a", "note-1", anchor), readerNoteDraftKey("book-b", "note-1", anchor));
  assert.notEqual(readerNoteDraftKey("book-a", "note-1", anchor), readerNoteDraftKey("book-a", "note-2", anchor));
  assert.notEqual(readerNoteDraftKey("book-a", null, anchor), readerNoteDraftKey("book-a", null, { ...anchor, location: "epubcfi(/6/6)" }));
});

test("rail cards follow visible anchors and never overlap", () => {
  const layout = layoutReaderRailNotes([
    { id: "later", location: "cfi-later", updated_at: 1 },
    { id: "first", location: "cfi-first", updated_at: 2 },
    { id: "unknown", location: null, updated_at: 3 },
  ], { later: 340, first: 80 }, 100, 12);

  assert.deepEqual(layout, [
    { id: "first", top: 80 },
    { id: "later", top: 340 },
    { id: "unknown", top: 452 },
  ]);
});

test("a fetched page smaller than the backend total is reported as truncated", () => {
  assert.equal(isNotesTruncated(128, 100), true);
  assert.equal(isNotesTruncated(100, 100), false);
  assert.equal(isNotesTruncated(0, 0), false);
});

test("an in-flight save outranks whatever the draft says", () => {
  assert.equal(
    resolveReaderNoteEditorStatus({ saving: true, draft: "changed", savedContent: "saved" }),
    "saving",
  );
  assert.equal(
    resolveReaderNoteEditorStatus({ saving: true, draft: "", savedContent: null }),
    "saving",
  );
});

test("a blank new note is idle, not unsaved — there is nothing to lose yet", () => {
  assert.equal(resolveReaderNoteEditorStatus({ saving: false, draft: "", savedContent: null }), "idle");
  assert.equal(resolveReaderNoteEditorStatus({ saving: false, draft: "   \n", savedContent: null }), "idle");
  assert.equal(resolveReaderNoteEditorStatus({ saving: false, draft: "typed", savedContent: null }), "unsaved");
});

test("only edits that survive trimming count as unsaved", () => {
  assert.equal(
    resolveReaderNoteEditorStatus({ saving: false, draft: "  A note\n", savedContent: "A note" }),
    "saved",
  );
  assert.equal(
    resolveReaderNoteEditorStatus({ saving: false, draft: "A note!", savedContent: "A note" }),
    "unsaved",
  );
  // Emptying a saved note is a real edit — it must not read as "saved".
  assert.equal(
    resolveReaderNoteEditorStatus({ saving: false, draft: "", savedContent: "A note" }),
    "unsaved",
  );
});

test("the page chip only shows a real page number", () => {
  assert.equal(readerNotePageNumber(1), 1);
  assert.equal(readerNotePageNumber(48), 48);
  assert.equal(readerNotePageNumber(0), null);
  assert.equal(readerNotePageNumber(-3), null);
  assert.equal(readerNotePageNumber(4.5), null);
  assert.equal(readerNotePageNumber(Number.NaN), null);
  assert.equal(readerNotePageNumber(undefined), null);
  assert.equal(readerNotePageNumber(null), null);
});
