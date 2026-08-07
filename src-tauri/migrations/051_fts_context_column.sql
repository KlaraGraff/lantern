-- Migration 052 — give the full-text index a second column holding the
-- chunk's context line, so keyword search can find a passage by who it is
-- about even when the passage itself only says "he".
--
-- Why the table is dropped rather than altered: FTS5 has no ALTER TABLE ADD
-- COLUMN. A virtual table's column list is fixed at creation, so the only
-- way to add one is to drop and recreate.
--
-- What is deliberately NOT done here: rebuilding the index from
-- `book_chunks`. The text has to be run through `segment_for_fts`, which is
-- a Rust function (it splits CJK, which SQLite cannot do), so SQL alone
-- cannot refill this table. `ai::grounding::index::ensure_fts_current`
-- does it on the next retrieval, driven by `fts_rebuild_state` below.
--
-- What is deliberately NOT touched: `book_chunks`. Its `context_line`
-- values were paid for with real AI calls, one request per chunk. Bumping
-- INDEX_VERSION to force a rebuild would have been the easy way to refill
-- FTS, and it would have deleted every one of them and billed the reader a
-- second time for text they already own. The rebuild below reads
-- `book_chunks`; it never writes it.

-- Which FTS row belongs to a chunk. Without this, updating one chunk's
-- context line means scanning the whole index for a matching `chunk_id` —
-- that column is UNINDEXED, so FTS5 cannot look it up. Context lines are
-- written one at a time as they stream back from the model, so that scan
-- would happen once per chunk of the book.
ALTER TABLE book_chunks ADD COLUMN fts_rowid INTEGER;

DROP TABLE IF EXISTS book_chunks_fts;

CREATE VIRTUAL TABLE book_chunks_fts USING fts5(
  seg_text,
  -- The chunk's `context_line`, segmented the same way. Empty until the
  -- context-line pass reaches this chunk, and empty forever if the reader
  -- never turns that pass on — an empty column costs nothing and simply
  -- never matches.
  seg_context,
  chunk_id UNINDEXED,
  book_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Watermark for Rust-side rebuilds of the index above. Separate from
-- `schema_version` on purpose: that one tracks SQL that has run, and the
-- work this tracks is exactly the work SQL cannot do.
CREATE TABLE IF NOT EXISTS fts_rebuild_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fts_version INTEGER NOT NULL
);
