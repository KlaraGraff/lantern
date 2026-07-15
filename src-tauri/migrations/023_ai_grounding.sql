-- Device-local derived book index. These tables are deliberately excluded from
-- sync snapshots and event logs: each device rebuilds them from its book blob.
CREATE TABLE IF NOT EXISTS book_chunks (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,
  section_index  INTEGER NOT NULL,
  section_href   TEXT,
  section_title  TEXT,
  char_start     INTEGER,
  char_end       INTEGER,
  text           TEXT NOT NULL,
  snippet        TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_chunks_order ON book_chunks(book_id, chunk_index);

CREATE VIRTUAL TABLE IF NOT EXISTS book_chunks_fts USING fts5(
  seg_text,
  chunk_id UNINDEXED,
  book_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS book_index_state (
  book_id       TEXT PRIMARY KEY,
  source_sha256 TEXT,
  index_version INTEGER NOT NULL,
  chunk_count   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT,
  indexed_at    INTEGER NOT NULL
);

-- Summaries are synced beginning in phase 2. Creating the table now keeps the
-- feature on one migration and makes local deletion deterministic from phase 1.
CREATE TABLE IF NOT EXISTS book_summaries (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  section_index INTEGER,
  section_title TEXT,
  content       TEXT NOT NULL,
  language      TEXT NOT NULL,
  model         TEXT,
  source_sha256 TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_summaries_scope
  ON book_summaries(book_id, scope, COALESCE(section_index, -1));
