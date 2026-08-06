-- Migration 046 — the local calibration table.
-- Design: docs/impls/reading-driven-mastery-and-review.md §5.2 and §8,
-- docs/impls/reading-flow-decisions-2026-08-06.md §4.1.
--
-- Not machine learning: the scoring rules in src-tauri/src/mastery/mod.rs
-- are untouched. This table only holds a few numbers measured from THIS
-- reader's own history — §8's own words, "算法本身一个字不改，只是把几个
-- 原本写死的数字，换成从用户自己的数据里量出来的数字".
--
-- Single row (id = 1), no history. §8.2's second guardrail — recompute
-- never rewrites already-decided learning state — means there is nothing
-- here worth keeping a timeline of: only "what do we currently believe"
-- matters, and src-tauri/src/calibration/mod.rs overwrites this row in
-- place, once a day, in full.
--
-- Device-local. Deliberately excluded from src-tauri/src/sync — no
-- EventBody variant exists for this table and none should be added. Per
-- §9.3, this is a "recompute on the new device instead of syncing" table,
-- the same rule reading_screen_dwells and reading_word_exposures
-- (migration 037) and level_observation_state (migration 042) already
-- follow. A number measured from this device's own reading history means
-- nothing carried to a device with a different one, and syncing it would
-- only invite a conflict between two numbers that are both "correct".
CREATE TABLE IF NOT EXISTS local_calibration (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- §5.1 / §8: median words-per-minute across this reader's own recent
  -- screens. NULL until reading_speed_sample_screens clears
  -- MIN_SCREENS_FOR_SPEED in the Rust module (30 — §5.1's own number).
  -- Stored for parity with §4.1's "at least these two statistics" ask;
  -- nothing reads it back yet — commands::reading_behavior's existing
  -- per-batch pace baseline still does that job at write time.
  reading_speed_wpm REAL,
  reading_speed_sample_screens INTEGER NOT NULL DEFAULT 0,

  -- §5.2: lookups per 1000 words read, aggregated across this device's
  -- whole local history. NULL until lookup_rate_sample_words clears
  -- MIN_WORDS_FOR_LOOKUP_RATE. This is the one that actually feeds mastery
  -- scoring — see calibration::lookup_rate_scale.
  lookup_rate_per_1000 REAL,
  -- Total words read this rate was measured against — the denominator, not
  -- a lookup count. Doubles as this statistic's own sample-size column.
  lookup_rate_sample_words INTEGER NOT NULL DEFAULT 0,

  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO local_calibration (id, updated_at) VALUES (1, 0);
