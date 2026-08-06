-- Migration 040 — the indexes bookmarks and highlights have never had.
--
-- 001 created both tables with `book_id TEXT NOT NULL REFERENCES books(id)
-- ON DELETE CASCADE` and no index on that column. SQLite does not index a
-- foreign key for you, so three separate things have been doing full table
-- scans since the first release:
--
--   1. Opening a book. commands/bookmarks.rs list_bookmarks and
--      list_highlights both run `WHERE book_id = ?1 ORDER BY created_at DESC`
--      on every open — a scan plus a sort, on a table holding every
--      annotation from every book in the library.
--   2. Deleting a book. The ON DELETE CASCADE has to find the child rows,
--      and without an index it scans both tables per parent row.
--   3. Merging a sync log. sync/merge.rs deletes by book_id the same way.
--
-- The composite (book_id, created_at) covers both halves of (1): the
-- equality prefix seeks straight to the book, and the trailing column
-- arrives already ordered, so the sort disappears too.
CREATE INDEX IF NOT EXISTS idx_bookmarks_book_created
  ON bookmarks (book_id, created_at);

CREATE INDEX IF NOT EXISTS idx_highlights_book_created
  ON highlights (book_id, created_at);

-- The annotations view (commands/annotations.rs) folds a note into its
-- highlight by correlating on (book_id, cfi_range) — once in an EXISTS
-- subquery and once in a LEFT JOIN — and it builds the whole item set
-- before any book filter applies. Without this the correlation re-scans
-- highlights for every note in the library. The index above cannot serve
-- it: the equality is on both columns, and created_at is the wrong second
-- column to seek through.
CREATE INDEX IF NOT EXISTS idx_highlights_book_cfi
  ON highlights (book_id, cfi_range);
