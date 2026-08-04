import assert from "node:assert/strict";
import test from "node:test";

import { layoutReaderRailNotes, readerNoteDraftKey } from "../src/components/reader-notes-rail.ts";

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
