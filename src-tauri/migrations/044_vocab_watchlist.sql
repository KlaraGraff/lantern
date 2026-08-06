-- Migration 044 — the observation zone.
-- See docs/impls/reading-flow-decisions-2026-08-06.md §1 and §5.
--
-- The first time a word is looked up, a `vocab_words` row is now created
-- automatically so mastery scoring and in-text 3-stage annotation can run on
-- it like any other saved word (both already key off `vocab_words`, and
-- neither should have to learn a second table). But the reader did not ask
-- to save it — they asked what it means — so the row starts in a state the
-- reader never sees: 'watchlist'. It behaves exactly like a saved word
-- everywhere except two places: the vocab list (defaults to hiding it) and
-- review piles (never draw members from it). Reaching a 3rd cumulative
-- lookup of the same word in the same book, or a manual save, promotes it to
-- 'confirmed' — the state every word saved before this migration is
-- backfilled to, and the only state the reader has ever consciously seen.
--
-- This is deliberately not a new user-facing concept: no name, no entry
-- point, no badge. It is a filter value on an existing list.
ALTER TABLE vocab_words ADD COLUMN list_status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK(list_status IN ('confirmed', 'watchlist'));

-- The vocab list's default filter (list_status = 'confirmed') and review
-- piles' hydration both scan this column on every row in the table.
CREATE INDEX IF NOT EXISTS idx_vocab_words_list_status ON vocab_words(list_status);
