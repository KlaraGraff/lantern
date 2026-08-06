-- Migration 047 — cache for the optional AI curation layer on review piles.
-- See docs/impls/reading-flow-decisions-2026-08-06.md §6 and
-- src-tauri/src/commands/review_pile_ai.rs.
--
-- The rule-computed piles in review_piles.rs are not stored anywhere — they
-- are recomputed on every read. This table exists only because the AI layer
-- on top of them costs real money and should not re-run on every page open:
-- a single cached row, replaced wholesale on each successful run, at most
-- once a day (see CURATION_TTL_MS in review_pile_ai.rs). No version history
-- is kept — a stale row is simply overwritten, and its members are
-- revalidated against the live piles on every read, so a row that predates
-- some now-deleted word is never a correctness problem, only a staleness one.
--
-- Singleton by construction (id is always 1): there is exactly one review
-- section, so there is exactly one curation of it.
CREATE TABLE IF NOT EXISTS review_pile_curation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at INTEGER NOT NULL,
  -- Vec<CuratedGroup>, JSON. Every pile/word reference inside is re-checked
  -- against the freshly recomputed rule piles at read time — this column is
  -- the model's claim, not yet a verified fact.
  groups_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL
);
