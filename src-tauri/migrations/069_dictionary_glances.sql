-- Migration 069 — the free dictionary strip becomes evidence.
-- See docs/impls/dictionary-glance-mastery.md.
--
-- Single-clicking a word pops the menu with a free dictionary definition on
-- top of it. Until now that was invisible to the mastery engine: it did not
-- lower a tier, did not enter lookup history, and did not even mark the screen
-- as lookup-active. For a reader whose habitual lookup *is* the single click,
-- their most common interaction fed nothing into the assessment.
--
-- A glance is now worth half a card lookup. Two columns' worth of storage is
-- all that needs to change.

-- (a) Card lookups and dictionary glances are counted separately inside the
-- repeat window, and the ladder's threshold is the *weighted* sum
-- (`lookups_in_window + 0.5 * glances_in_window` — see mastery::chain_weight).
--
-- Two integer counters rather than one REAL weight, for two reasons. The
-- word-detail page has to say what the reader actually did — "you opened the
-- card once and checked the dictionary twice" — so both numbers are needed on
-- their own regardless; and a stored weight alongside the counts it is
-- computed from is redundant state that can drift from them.
--
-- Backfills to 0, which is exactly right: no glance has ever been recorded, so
-- every existing chain is entirely card lookups and its weight is unchanged.
-- That is the same property the whole change is built on — 1.0/2.0/3.0 on the
-- new ladder is bit-for-bit the old 1st/2nd/3rd lookup for a reader who never
-- glances.
ALTER TABLE mastery_progress
  ADD COLUMN glances_in_window INTEGER NOT NULL DEFAULT 0 CHECK(glances_in_window >= 0);

-- (b) The lifetime glance ledger, one row per (book, word).
--
-- Device-local and never synced, for the same reason reading_word_exposures
-- (037), mastery_progress and mastery_events (038, 039) are not: it is derived
-- from this device's own reading behaviour. Nothing here emits a sync event.
-- The *conclusions* it drives — a tier on vocab_words, the sentence in
-- mastery_reason — travel on the syncable path exactly as they already do.
--
-- Deliberately NOT lookup_records. Every row of that table is a card the
-- reader can re-open; a glance has no card, and filing one there would put
-- rows in the history list and in exports that cannot be opened.
--
-- `glance_count` is a lifetime total, not a windowed one. It exists to answer
-- "does this word keep stopping you", which is what the entry threshold
-- (4 glances -> the word joins the watchlist) is asking. The 7-day repeat
-- window is a separate question and lives on mastery_progress.
--
-- `last_cfi` + `last_glanced_at` are what the 60-second same-position dedupe
-- compares against, so a mis-click that reopens the same menu twice is one
-- glance rather than two.
CREATE TABLE IF NOT EXISTS dictionary_glances (
    book_id          TEXT NOT NULL,
    normalized_word  TEXT NOT NULL,
    glance_count     INTEGER NOT NULL DEFAULT 0 CHECK(glance_count >= 0),
    first_glanced_at INTEGER NOT NULL,
    last_glanced_at  INTEGER NOT NULL,
    last_cfi         TEXT,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (book_id, normalized_word)
);
