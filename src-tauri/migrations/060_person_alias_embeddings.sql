-- Migration 060 — durable vectors for `kind = 'description'` person aliases.
-- See src-tauri/src/ai/grounding/aliases.rs (`resolve_descriptions`) and
-- src-tauri/src/ai/grounding/vector.rs (`ensure_alias_vector_table`).
--
-- This is the follow-up migration 059's `kind` comment promised: a
-- 'description' row ("那个总在拍马屁的牧师" → Mr. Collins) cannot be found by
-- the substring scan that serves 'name' rows, so it is matched by cosine
-- similarity against the same query embedding retrieval already computes.
--
-- Two tables, not one, mirroring `book_chunk_embeddings` +
-- `book_chunk_vectors` exactly. This table is the durable store; the vec0
-- virtual table `book_alias_vectors` is a derived index created in Rust
-- (`ensure_alias_vector_table`) because its column type carries the
-- configured dimension, which no static migration can know.
--
-- The alias vectors deliberately do NOT live in `book_chunk_vectors`. That
-- table is DROPped wholesale whenever the configured dimension changes and
-- repopulated only from `book_chunk_embeddings`, so anything else parked in
-- it is erased without a trace — and a description alias is the one thing in
-- this feature a reader typed by hand and no rebuild could reconstruct.
-- Keeping the pair separate also means the model-change recompute for these
-- rows falls out of the same "generate vectors" step chapter vectors already
-- take, rather than needing a path of its own.
--
-- Device-local derived data, like `book_chunk_embeddings` and for the same
-- reason: re-embedding an alias costs one short embedding call against text
-- that is already in `book_person_aliases`, so there is nothing here worth
-- putting in the sync container. (The alias *text* not syncing is migration
-- 059's tradeoff, not this one's.)
--
-- `model` and `dimensions` are stored per row rather than assumed from
-- settings, because a row written under an earlier embedding model is not
-- comparable to a query vector from the current one — that mismatch is what
-- `ensure_alias_embeddings` reads to decide which rows to recompute.
--
-- No ON DELETE CASCADE that anyone should rely on: this database opens with
-- `PRAGMA foreign_keys=OFF` (see db.rs), so the REFERENCES clause is
-- documentation. Every delete path in aliases.rs clears these rows itself.
CREATE TABLE book_person_alias_embeddings (
  alias_id   TEXT PRIMARY KEY REFERENCES book_person_aliases(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL,
  embedding  BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_book_person_alias_embeddings_book
  ON book_person_alias_embeddings(book_id);
