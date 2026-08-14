-- Migration 074 — 词卷收藏 (quiz-sourced vocabulary): `book_id` becomes
-- nullable and the row records where it came from.
-- See docs/impls/quiz-word-lookup.md §二 and §三.
--
-- Why a rebuild. A word saved from the quiz grading page has no book behind
-- it — no `books` row, no CFI, nothing to locate. Every other column already
-- tolerates that; `book_id NOT NULL` is the single thing standing in the way,
-- and SQLite can only relax NOT NULL by recreating the table (the documented
-- 12-step ALTER procedure). So this is a verbatim copy of the schema
-- migrations 002/009/011/012/017/019/038/044/067 accumulated, with exactly
-- three differences:
--
--   1. `book_id` loses NOT NULL. It keeps `REFERENCES books(id) ON DELETE
--      CASCADE` — a NULL child is not constrained by a foreign key, so a
--      quiz-sourced word is simply never touched by a book deletion, which
--      is precisely the intent: it never belonged to a book to begin with.
--   2. `source` — 'book' for everything that exists today (and everything
--      the reader still saves while reading), 'quiz' for the grading page.
--      NOT NULL with a default so no writer has to think about it.
--   3. `source_label` — display text only, e.g. "8/14 今日词卷". NULL for
--      book-sourced rows, which already have a book title to show.
--
-- The effective column set was read off a real migrated database rather
-- than transcribed from the migration files by hand, and `db.rs`'s
-- `migration_074_*` tests assert it (columns, NOT NULL flags, defaults, and
-- the index set) against a database that ran the whole chain.
--
-- Foreign keys must be OFF while this runs: `mastery_progress`,
-- `mastery_events` and `vocab_review_log` are FK children of `vocab_words`
-- with ON DELETE CASCADE, so `DROP TABLE vocab_words` with enforcement on
-- would take every mastery timeline and review-history row down with it.
-- `db.rs::apply_migration` disables it around this migration the same way it
-- does for 009.

CREATE TABLE vocab_words_new (
  id TEXT PRIMARY KEY,
  book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  definition TEXT NOT NULL,
  context_sentence TEXT,
  cfi TEXT,
  mastery TEXT NOT NULL DEFAULT 'new',
  review_count INTEGER NOT NULL DEFAULT 0,
  next_review_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_device TEXT NOT NULL DEFAULT 'migration',
  context_explanation TEXT,
  review_interval_days INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at INTEGER,
  last_review_rating TEXT,
  fsrs_stability REAL,
  fsrs_difficulty REAL,
  fsrs_version INTEGER NOT NULL DEFAULT 1,
  mastery_source TEXT NOT NULL DEFAULT 'manual',
  mastery_reason TEXT,
  list_status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK(list_status IN ('confirmed', 'watchlist')),
  card_snapshot TEXT,
  source TEXT NOT NULL DEFAULT 'book',
  source_label TEXT
);

INSERT INTO vocab_words_new
  (id, book_id, word, definition, context_sentence, cfi, mastery,
   review_count, next_review_at, created_at, updated_at, updated_by_device,
   context_explanation, review_interval_days, last_reviewed_at,
   last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version,
   mastery_source, mastery_reason, list_status, card_snapshot)
SELECT
   id, book_id, word, definition, context_sentence, cfi, mastery,
   review_count, next_review_at, created_at, updated_at, updated_by_device,
   context_explanation, review_interval_days, last_reviewed_at,
   last_review_rating, fsrs_stability, fsrs_difficulty, fsrs_version,
   mastery_source, mastery_reason, list_status, card_snapshot
FROM vocab_words;

DROP TABLE vocab_words;
ALTER TABLE vocab_words_new RENAME TO vocab_words;

-- Every index the old table carried, recreated verbatim: migration 002's
-- book/mastery pair, 017's due-review composite, 044's list_status filter.
-- A rebuild that forgets one turns a seek into a full scan silently.
CREATE INDEX IF NOT EXISTS idx_vocab_book_id ON vocab_words(book_id);
CREATE INDEX IF NOT EXISTS idx_vocab_mastery ON vocab_words(mastery);
CREATE INDEX IF NOT EXISTS idx_vocab_due_review
  ON vocab_words(next_review_at, mastery);
CREATE INDEX IF NOT EXISTS idx_vocab_words_list_status ON vocab_words(list_status);
