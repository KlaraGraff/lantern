-- Automatic highlights are derived, not stored. Every lookup you made with a
-- location, and every passage you quoted into a chat, already carries the two
-- things a highlight needs: a CFI range and the text. Writing a `highlights`
-- row for each of them would duplicate that data and then have to keep the copy
-- in step with the original forever, so `list_auto_highlights` computes them on
-- read instead.
--
-- The one thing derivation cannot recover is a decision: "I do not want to see
-- this one." That is not in the lookup or the chat message, so it needs a row
-- of its own, and this is that row. Nothing else about an automatic highlight
-- is persisted.
--
-- `dismissed` is a flag rather than the row's presence so that undo is an
-- update with a fresh `updated_at`, which is what LWW needs to beat a peer's
-- stale dismissal. Deleting the row would leave the peer's copy winning.
--
-- Orphans are expected and harmless. `lookup_records` is deliberately not part
-- of the sync stream (see migration 014), so a dismissal that syncs to another
-- device may name an anchor that device has never derived. It sits inert until
-- the same lookup happens there, exactly like a `word_mark_exceptions` row that
-- arrives before its rule.
CREATE TABLE auto_highlight_dismissals (
  -- Deterministic: sha256 over (book_id, anchor). See `auto_highlight_dismissal_id`.
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- The derived highlight's stable anchor, e.g. "lookup:<record id>" or
  -- "chat:<message id>:<quote index>". Opaque here on purpose: the shape is
  -- owned by the deriving code, and this table only has to compare it.
  anchor TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_device TEXT NOT NULL DEFAULT 'migration',
  UNIQUE(book_id, anchor)
);

CREATE INDEX idx_auto_highlight_dismissals_book
  ON auto_highlight_dismissals(book_id, dismissed);
