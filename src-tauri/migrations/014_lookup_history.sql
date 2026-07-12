-- Local reading activity. Lookup history is intentionally not part of the
-- iCloud event stream yet: it is high-volume and needs a complete event /
-- merge / snapshot protocol before it can safely sync across old clients.
CREATE TABLE IF NOT EXISTS lookup_records (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lookup_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  context_sentence TEXT,
  chapter TEXT,
  cfi TEXT,
  definition TEXT NOT NULL DEFAULT '',
  context_explanation TEXT,
  created_at INTEGER NOT NULL,
  last_looked_up_at INTEGER NOT NULL,
  lookup_count INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lookup_records_position
  ON lookup_records(book_id, cfi, normalized_text);
CREATE INDEX IF NOT EXISTS idx_lookup_records_book_cfi
  ON lookup_records(book_id, cfi);
CREATE INDEX IF NOT EXISTS idx_lookup_records_recent
  ON lookup_records(last_looked_up_at DESC);
