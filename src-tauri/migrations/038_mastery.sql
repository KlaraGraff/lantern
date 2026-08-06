-- Migration 038 — data model for reading-driven vocabulary mastery.
-- See docs/impls/reading-driven-mastery-and-review.md.
--
-- (a) A fourth mastery tier, 'familiar', sits between 'learning' and
-- 'mastered'. vocab_words.mastery has never had a CHECK constraint (see
-- migrations 002 and 009 — plain `TEXT NOT NULL DEFAULT 'new'`), so no DDL
-- is needed here; the only enforcement is validate_mastery() in
-- commands/vocab.rs.

-- (b) 'auto' when the reading-exposure engine decided the tier, 'manual'
-- when the user set it or a review decided it. Defaults to 'manual' because
-- everything that exists before this migration was user- or review-driven.
-- Kept separate from `mastery` so that if the automatic scoring is later
-- found to be badly calibrated, only the 'auto' rows can be rolled back
-- without touching what the user asserted themselves.
ALTER TABLE vocab_words ADD COLUMN mastery_source TEXT NOT NULL DEFAULT 'manual';

-- (b.1) The facts the word-detail page renders its one-sentence explanation
-- from, e.g. {"reason":"exposure_promotion","book_id":"...","distinct_days":3,
-- "exposures":4,"lookups":0}. JSON text, or NULL when no automatic decision
-- has ever been made for this word. Nothing in Rust parses this — it is
-- stored and forwarded verbatim, and the frontend renders it through i18n.
-- Deliberately a denormalized copy of the newest mastery_events.detail:
-- mastery_events is device-local (see (c) below), but the explanation is
-- not optional — a reader who opens a second device and sees "familiar /
-- decided automatically" with no reason attached has been told their
-- learning state changed silently, which is exactly what the design
-- forbids. The timeline may restart on a new device; the sentence may not
-- disappear.
ALTER TABLE vocab_words ADD COLUMN mastery_reason TEXT;

-- (c) Local-only timeline of mastery-tier transitions, one row per change.
-- Device-local for the same reason reading_word_exposures (037) is: it is
-- derived from this device's own reading behaviour, not cross-device state.
--
-- `reason` is a stable machine-readable code, never display text (all
-- user-facing strings are i18n keys — see AGENTS.md). Known codes:
--   exposure_promotion    — reading-exposure engine raised the tier
--   lookup_demotion       — a lookup lowered the tier
--   repeat_lookup_demotion — a repeated lookup lowered the tier further
--   user_override         — the user set the tier directly
--   review_promotion      — an SRS review raised the tier
--   review_demotion       — an SRS review lowered the tier
CREATE TABLE IF NOT EXISTS mastery_events (
    id TEXT PRIMARY KEY,
    vocab_word_id TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
    from_mastery TEXT NOT NULL,
    to_mastery TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('auto', 'manual', 'review')),
    reason TEXT NOT NULL,          -- machine-readable reason code, NOT display text
    detail TEXT NOT NULL DEFAULT '{}',  -- JSON: the numbers the reason was computed from
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mastery_events_word_created
ON mastery_events(vocab_word_id, created_at DESC);
