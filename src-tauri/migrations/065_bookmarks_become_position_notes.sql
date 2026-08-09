-- Migration 065 — retire `bookmarks`; a bookmark is a note anchored at a
-- position.
--
-- Two mechanisms grew side by side for "I want to come back to this spot".
-- `bookmarks` held a location and an optional one-line `label`; `notes` held a
-- location and written text. The reader had two buttons for them, the reader
-- panel had two tabs, and the two tables could not be ordered against each
-- other without a union in every read path. They are the same idea: a place,
-- plus a sentence you may or may not have written.
--
-- So the table goes and its rows move into `notes` under a third
-- `anchor_kind`, `'position'` — the sibling of `'selection'` (a quoted range)
-- and `'word'` (a term). A position note has a `location` and no
-- `selected_text`: it points at a spot in the book rather than at any
-- particular sentence in it. That is what makes it the only way to write
-- something down without first selecting text, which is a capability the
-- merge must not cost us — the point is that one button now yields both a
-- bookmark and a note, not that one of the two disappears.
--
-- Migration 035 did the same job for `highlights.note` and this follows it:
--
--   * The id carries across unchanged rather than being regenerated. A
--     bookmark's row and its note are the same entity, not a copy of one
--     into the other, so re-running this cannot mint a second copy — the
--     primary key catches it, and `INSERT OR IGNORE` is the belt to those
--     braces.
--   * Both timestamps carry across unchanged. This moves an existing write,
--     it does not make a new one; advancing the LWW clock here would let
--     whichever device happened to upgrade last win merges it did not earn.
--   * No sync event is emitted. Every device runs this same statement over
--     the same already-replicated `bookmarks` rows and derives byte-identical
--     `notes` rows, so the fleet converges without a word on the wire. That is
--     also why `updated_by_device` is the constant `'migration'` (the table's
--     own column default, and what 021 left on the rows it moved) instead of
--     this device's id: a per-device value would make the derived row differ
--     per device and hand the LWW tie-break to an accident of upgrade order.
--
-- `bookmarks` had no `updated_by_device` at all — it was append-only, no LWW.
-- `label` was nullable; `notes.content` is `NOT NULL DEFAULT ''`, and an empty
-- string is the honest spelling of "a place I marked and did not write on".
--
-- Recreating the table before reading it is what makes this whole script
-- re-runnable: on the second pass the `CREATE TABLE IF NOT EXISTS` supplies an
-- empty table, the insert copies nothing, and the drop puts it back the way it
-- was. Without it a re-run dies on "no such table: bookmarks".
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Fold the delete markers first, so the insert below can see them.
--
-- A deleted bookmark leaves a `('bookmark', id)` row in `_tombstones`, and
-- after this migration nothing asks that question under that name: the row is
-- a note now, and `merge::is_tombstoned` will be asked about `('note', id)`.
-- Left alone, a `bookmark.add` still sitting in an un-replayed peer log would
-- find no tombstone and resurrect a bookmark the reader deleted. `MAX(ts)` on
-- conflict matches `merge::insert_tombstone`, so folding is order-independent
-- and safe to repeat.
INSERT INTO _tombstones (entity, id, ts)
SELECT 'note', id, ts FROM _tombstones WHERE entity = 'bookmark'
ON CONFLICT(entity, id) DO UPDATE SET ts = MAX(_tombstones.ts, excluded.ts);

DELETE FROM _tombstones WHERE entity = 'bookmark';

INSERT OR IGNORE INTO notes (
  id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
  content, content_format, created_at, updated_at, updated_by_device
)
SELECT
  b.id,
  b.book_id,
  'position',
  NULL,
  'book',
  b.cfi,
  NULL,
  COALESCE(b.label, ''),
  'plain_text',
  b.created_at,
  b.updated_at,
  'migration'
FROM bookmarks b
WHERE NOT EXISTS (
  SELECT 1 FROM _tombstones t WHERE t.entity = 'note' AND t.id = b.id
);

-- Takes `idx_bookmarks_book_created` (migration 040) with it. Reads by book
-- land on `idx_notes_book_updated` (migration 021) instead, which seeks on the
-- same `book_id` prefix.
DROP TABLE bookmarks;
