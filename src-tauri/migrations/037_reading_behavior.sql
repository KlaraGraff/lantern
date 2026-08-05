-- Raw collection for the future mastery/review engine described in
-- docs/impls/reading-driven-mastery-and-review.md. This migration adds
-- storage only: nothing here computes a mastery score or a display weight,
-- both are later batches. Both tables are device-local for now (see the
-- header note on reading_sessions in 033_reading_stats.sql for the same
-- rule) — pending the cross-device sync wiring called out in the doc's
-- §9.3, which is explicitly out of scope for this migration.

-- One row per finished "screen" (a page, or a scroll position the reader
-- settled on). Feeds two calibration dimensions from §5: §5.1's
-- word-count/dwell reading-speed signal, and §2.4's exclusion rule for
-- screens that were open a long time with no user activity at all.
CREATE TABLE reading_screen_dwells (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- Free-text chapter label, sourced the same way as lookup_records.chapter
  -- (chapters[currentChapterIndex].title in Reader.tsx) so the two tables
  -- stay joinable on (book_id, chapter). Not a stable chapter id.
  chapter TEXT,
  -- Best-effort CFI anchor for the screen (start of the visible range).
  -- Informational only; nothing here re-navigates to it.
  cfi TEXT,
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  ended_at INTEGER NOT NULL CHECK(ended_at >= started_at),
  -- Precomputed ended_at - started_at so the §2.4 "dwelt >= 5 minutes"
  -- check is a plain column comparison, not per-row arithmetic.
  dwell_ms INTEGER NOT NULL CHECK(dwell_ms >= 0),
  -- Count of qualifying operations during this screen's dwell: word
  -- selection, a lookup, a bookmark, or an annotation. A page turn ends a
  -- screen rather than counting as an in-dwell operation, and a relocate
  -- from scrolling is what defines the screen boundary itself, so neither
  -- is double-counted here. This is the exact §2.4 signal for "the screen
  -- was open >= 5 minutes AND had zero operations" -> exclude as unreliable
  -- evidence (per the user's explicit correction: it is the AND of both
  -- conditions, never dwell time alone).
  operation_count INTEGER NOT NULL DEFAULT 0 CHECK(operation_count >= 0),
  -- Subset of operation_count that were actual dictionary lookups. A
  -- screen with lookup_count > 0 is the trigger for §2.1/§2.4's rule that
  -- the OTHER words on that screen (the ones not looked up) are stronger
  -- "already knows this" evidence than an ordinary screen.
  lookup_count INTEGER NOT NULL DEFAULT 0 CHECK(lookup_count >= 0),
  -- Total word-like tokens in the visible text (not deduped, stopwords
  -- included) — the numerator for §5.1's words-per-minute reading-speed
  -- calibration dimension. Distinct from reading-pace.ts's existing
  -- percent-based estimator; this is a new, separate input.
  word_count INTEGER NOT NULL DEFAULT 0 CHECK(word_count >= 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_reading_screen_dwells_book_started
  ON reading_screen_dwells(book_id, started_at DESC);

-- Per-(book, chapter, word) aggregate of viewport exposure, deliberately
-- one row per word rather than one row per screen (§9.2 is explicit that
-- viewport exposure records must be aggregated by word, not one row per
-- screen). This is the core gap §2.1 calls out as entirely unrecorded
-- today: a word appearing on screen that the reader did NOT look up is
-- itself positive "may already know this" evidence, and previously nothing
-- captured that at all.
CREATE TABLE reading_word_exposures (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- Same free-text chapter label as reading_screen_dwells.chapter and
  -- lookup_records.chapter. NOT NULL (empty string when unknown) so the
  -- unique index below dedupes reliably.
  chapter TEXT NOT NULL DEFAULT '',
  -- Mirrors Rust's normalize() in commands/lookup_history.rs so this joins
  -- cleanly against lookup_records.normalized_text on (book_id, chapter,
  -- normalized_text) to tell "looked up" and "seen but not looked up"
  -- exposures apart.
  normalized_word TEXT NOT NULL,
  -- Total times this word was seen on a settled screen in this chapter.
  -- This is the raw count §2.2's future diminishing-but-never-zero weight
  -- table (1st=1.0, 2nd=0.4, 3rd=0.2, 4th=0.1, 5th+=0.05 capped) will be
  -- computed from — the design doc explicitly rejects counting a repeat
  -- only once per chapter, so every occurrence must stay in this count.
  -- A screen is only folded into this count when it does NOT match the
  -- §2.4 exclusion rule above (>=5 minutes dwell with zero operations);
  -- reading_screen_dwells keeps the raw per-screen facts so that choice can
  -- be revisited later without re-deriving it from scratch.
  encounter_count INTEGER NOT NULL DEFAULT 0 CHECK(encounter_count >= 0),
  -- Subset of encounter_count where this word was on a screen where some
  -- OTHER word was looked up (lookup_count > 0 on that screen) — never
  -- incremented for the word that was itself the looked-up one. Raw input
  -- for the §2.1/§2.4 upweighting rule; the weighting itself is future
  -- work, only the count is collected now.
  encounters_on_lookup_active_screen INTEGER NOT NULL DEFAULT 0
    CHECK(encounters_on_lookup_active_screen >= 0 AND encounters_on_lookup_active_screen <= encounter_count),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_reading_word_exposures_book_chapter_word
  ON reading_word_exposures(book_id, chapter, normalized_word);
CREATE INDEX idx_reading_word_exposures_book_word
  ON reading_word_exposures(book_id, normalized_word);
