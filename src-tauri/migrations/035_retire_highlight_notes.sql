-- Migration 035 — retire `highlights.note`; notes live in `notes` only.
--
-- Two note mechanisms grew side by side. A highlight could carry text in its
-- own `note` column (written from the reader's highlight panel), while the
-- `notes` table held everything else — word notes, selection notes, notes on
-- a passage the reader never highlighted. Nothing joined them, so the same
-- passage could hold two notes that never saw each other, and every reader of
-- the data had to know both spellings of "this passage has a note".
--
-- The new Annotations page unions highlights and notes into one timeline. It
-- folds a `notes` row into a highlight when `notes.location` equals
-- `highlights.cfi_range` for the same book. Keeping the inline column would
-- mean a second, unfoldable source for the same idea — a permanent branch in
-- every read path. So the column goes, and the text it held moves into the
-- table that already knows how to carry it.
--
-- Migration 021 already copied the notes that existed then, using the same
-- `legacy-highlight-note-<id>` key. This pass picks up everything written
-- since. The id stays derived from the highlight id rather than random, so a
-- re-run cannot mint a second copy; the NOT EXISTS guard is the belt to that
-- primary key's braces, and also skips anchors where the reader has since
-- written a real note over the same range.
--
-- `updated_by_device` and both timestamps are carried across unchanged: this
-- moves an existing edit, it does not make a new one, so the LWW clock must
-- not advance or this device would start winning merges it did not earn.
INSERT OR IGNORE INTO notes (
  id, book_id, anchor_kind, normalized_word, scope, location, selected_text,
  content, content_format, created_at, updated_at, updated_by_device
)
SELECT
  'legacy-highlight-note-' || h.id,
  h.book_id,
  'selection',
  NULL,
  'book',
  h.cfi_range,
  h.text_content,
  h.note,
  'plain_text',
  h.created_at,
  h.updated_at,
  h.updated_by_device
FROM highlights h
WHERE h.note IS NOT NULL
  AND TRIM(h.note, char(9) || char(10) || char(13) || char(32)) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM notes n
    WHERE n.anchor_kind = 'selection'
      AND n.book_id = h.book_id
      AND n.location = h.cfi_range
  );

-- No index, view, or trigger references the column, so the cheap form applies.
-- (DROP COLUMN needs SQLite 3.35+; the bundled build is well past that.)
ALTER TABLE highlights DROP COLUMN note;
