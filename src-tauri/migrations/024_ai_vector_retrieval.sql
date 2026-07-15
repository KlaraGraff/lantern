-- Optional local-only embeddings for grounded book chat. Neither table is
-- represented in sync events or snapshots: both can be rebuilt from chunks.
CREATE TABLE IF NOT EXISTS book_chunk_embeddings (
  chunk_id      TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  dimensions    INTEGER NOT NULL,
  model         TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_chunk_embeddings_book ON book_chunk_embeddings(book_id);

-- Cached per enabled profile configuration. Credentials are intentionally not
-- stored here; the current local secret is resolved only when a request runs.
CREATE TABLE IF NOT EXISTS ai_embedding_capabilities (
  profile_id TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  model      TEXT NOT NULL,
  available  INTEGER NOT NULL,
  reason     TEXT,
  checked_at INTEGER NOT NULL
);
