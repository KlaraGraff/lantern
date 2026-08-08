-- Migration 059 — person aliases for cross-language / cross-form retrieval.
-- See docs/impls/person-aliases.md and src-tauri/src/ai/grounding/aliases.rs.
--
-- Device-local derived data, same as book_chunks and its siblings from
-- migration 023/050 — it does not enter the sync container. `source = 'auto'`
-- rows are a rebuild of one model call against the book already on this
-- device, so there is nothing to lose by not syncing them: a fresh device
-- just runs the build pass again on import. `source = 'user'` rows are the
-- one thing here that isn't rebuildable and therefore don't travel — a real
-- product tradeoff (a reader who teaches an alias on their phone won't see
-- it on their laptop), left as-is because this table cannot touch
-- src-tauri/src/sync/** in this change; revisit if that gap turns out to
-- matter in practice.
--
-- The unique index is on (book_id, alias, canonical), not (book_id, alias):
-- one alias is allowed to point at more than one canonical ("达西小姐" could
-- be Georgiana Darcy or Miss Darcy), and that ambiguity is exactly what
-- resolve()'s confidence tiers are counting — COUNT(DISTINCT canonical) per
-- alias, not a question put to the model.
--
-- `kind` splits the table into two rows that need different matching and
-- come from different places. 'name' rows ("达西" → "Mr. Darcy") are proper
-- names — the auto-build pass only ever writes these, and resolve() matches
-- them by exact longest-first substring, per the doc. 'description' rows
-- ("那个总在拍马屁的牧师" → "Mr. Collins") only ever come from a reader
-- teaching one by hand; a single reworded phrase misses exact matching
-- entirely, so these are matched by embedding similarity in a follow-up
-- change and resolve()'s substring scan skips them outright rather than
-- falling back to a partial-match guess. `source_query` exists only for
-- 'description' rows: the full question the reader was asking when they
-- taught it, kept for provenance since the alias text itself is not
-- self-explanatory the way a name is.
CREATE TABLE book_person_aliases (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  canonical    TEXT NOT NULL,   -- the book's own spelling, e.g. "Mr. Collins"
  alias        TEXT NOT NULL,   -- another way to refer to them, e.g. "柯林斯"
  source       TEXT NOT NULL,   -- 'auto' | 'user'
  mentions     INTEGER NOT NULL DEFAULT 0,  -- chunks where canonical appears verbatim
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'name',  -- 'name' | 'description'
  source_query TEXT  -- for 'description' rows: the query the user was asking when they taught it
);
CREATE UNIQUE INDEX idx_book_person_aliases_unique
  ON book_person_aliases(book_id, alias, canonical);
CREATE INDEX idx_book_person_aliases_book ON book_person_aliases(book_id, alias);
