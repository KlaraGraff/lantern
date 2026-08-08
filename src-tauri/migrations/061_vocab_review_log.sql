-- Migration 061 — append-only log of every SRS review outcome.
--
-- `vocab_words.last_review_rating` / `last_reviewed_at` / `fsrs_stability` /
-- `fsrs_difficulty` are overwritten on every review: they answer "what is
-- true now", not "what happened, in order". `mastery_events` (migration 038)
-- comes closer, but it only fires on a mastery-tier jump, not on every
-- reviewed card, and it is device-local (not synced) by design. A future
-- FSRS parameter optimizer needs the full ordered (review time, rating)
-- sequence per card — exactly the thing every prior write path has been
-- discarding. This table is where that sequence starts accumulating.
--
-- Append-only, on purpose: a review is a historical fact, not a current
-- state. There is no UPDATE path and there must never be one — even a
-- correction is a new row, not an edit of the old one, so that replaying
-- the log always reconstructs the same timeline. That is also why the merge
-- rule for this table (`sync::merge::apply_vocab_review_append`) is plain
-- "insert if this id is not already present, else skip": there is nothing to
-- arbitrate between two writes of the same id, unlike the mutable rows in
-- this file's neighbors, whose merge rule instead compares
-- `(updated_at, updated_by_device)`.
--
-- History is NOT backfilled from existing `vocab_words` rows. Every review
-- before this migration only ever had its outcome overwritten in place, so
-- everything but the single most recent rating is already gone — there is
-- no source to reconstruct it from, honestly or otherwise. Rows only start
-- appearing from the first review recorded after this migration runs.
--
-- `state_before` / `stability_before` / `difficulty_before` capture the
-- FSRS card state as it stood immediately before this review's scheduling
-- call ran, not after — the "prior" side of the (before, rating) -> after
-- transition an optimizer needs. All three are NULL for a card's first-ever
-- review, which has no "before".
--
-- The `REFERENCES ... ON DELETE CASCADE` below never fires: the app runs with
-- `PRAGMA foreign_keys=OFF` (`db.rs`) and cascades every delete by hand. It is
-- written anyway to state which row owns which, matching `mastery_events`
-- (038) and `mastery_progress` (039) — both of which declare the same cascade
-- and are likewise never swept when a word is deleted. Rows here therefore
-- outlive their word, which for a log of things that happened is the right
-- answer rather than an oversight: deleting the word does not un-happen the
-- review, and the id stays a usable grouping key for an optimizer.
CREATE TABLE IF NOT EXISTS vocab_review_log (
    id TEXT PRIMARY KEY,
    vocab_word_id TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
    reviewed_at INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('again', 'hard', 'good', 'easy')),
    -- FSRS state (New / Learning / Review / Relearning) the card was in
    -- before this review. Text, not an enum column, matching how `rating`
    -- and `vocab_words.mastery` are already stored — SQLite has no enum
    -- type, and the CHECK constraint is the actual enforcement.
    state_before TEXT,
    stability_before REAL,
    difficulty_before REAL,
    elapsed_days INTEGER,
    scheduled_days INTEGER,
    -- Which build of the scheduler produced this row's numbers. Same integer
    -- vocabulary as `vocab_words.fsrs_version` (migration 019), and for the
    -- same reason: a version swap changes what the stability and difficulty
    -- numbers mean, so an optimizer reading this log has to know which rows
    -- came from which algorithm before it can pool them.
    fsrs_version INTEGER,
    created_at INTEGER NOT NULL,
    updated_by_device TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocab_review_log_word_reviewed
ON vocab_review_log(vocab_word_id, reviewed_at);
