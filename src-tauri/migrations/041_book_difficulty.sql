-- Migration 041 — the local book-difficulty preview.
-- See docs/impls/book-difficulty.md §4.
--
-- One row per book, holding the vocabulary-band distribution computed by
-- walking the book's full text through the frequency table in
-- src/word_frequency/. Everything here is derived from a local file by a
-- deterministic pass — no network, no AI, no user data beyond the override.
--
-- Not synced, on purpose. Every device can recompute this from the same
-- file in seconds, so shipping it through the iCloud event log would only
-- add conflict surface for a value that cannot legitimately differ.
-- `override` is genuine user input and in principle should sync, but it
-- hangs off a table that does not; if that becomes a real complaint the
-- answer is a new synced entity, not a column bolted onto this table
-- (AGENTS.md: no compatibility shims).
CREATE TABLE IF NOT EXISTS book_difficulty (
  book_id        TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,     -- pending|running|done|failed|too_short|unsupported
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  distinct_words INTEGER NOT NULL DEFAULT 0,
  band1          INTEGER NOT NULL DEFAULT 0,
  band2          INTEGER NOT NULL DEFAULT 0,
  band3          INTEGER NOT NULL DEFAULT 0,
  band4          INTEGER NOT NULL DEFAULT 0,
  band5          INTEGER NOT NULL DEFAULT 0,
  -- Words the table has never heard of, kept out of band 5 deliberately:
  -- character names recur constantly in a novel, and folding them into
  -- "genuinely rare" would make every novel look harder than it is.
  band_unlisted  INTEGER NOT NULL DEFAULT 0,
  -- Which version of the file this was computed from. A changed hash
  -- (re-import, OCR rerun) is what makes a stored row stale.
  source_sha256  TEXT,
  computed_at    TEXT,
  error          TEXT,              -- the failure state's message, when status='failed'
  override       TEXT               -- NULL|'easier'|'matched'|'harder'|'hidden'
);
