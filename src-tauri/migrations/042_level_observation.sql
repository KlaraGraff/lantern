-- Migration 042 — the level observation row's memory.
-- See docs/impls/reading-driven-mastery-and-review.md §6 (category B) and §7.
--
-- The row itself computes nothing persistent: every number it shows is
-- derived on demand from lookup_records and reading_word_exposures. The only
-- thing that has to survive a restart is what the reader did about it, which
-- is exactly what these two tables hold.
--
-- Device-local, deliberately, and for the same reason reading_sessions and
-- reading_word_exposures are: the observation is drawn from this device's
-- records, the UI says so out loud ("this device's records"), and a
-- suppression synced from a device with a different reading history would be
-- silencing a remark that device never made.
--
-- Nothing here stores a level. §7's first rule is that this feature never
-- writes cefr_level; a table that could hold one would be the first step
-- towards a background job that does.

-- Single-row switch. `stopped` is the reader having said "stop this
-- comparison" — an off switch, not a snooze, so it is a flag and not a
-- timestamp: there is no arithmetic that can turn it back on.
CREATE TABLE IF NOT EXISTS level_observation_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  stopped        INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  -- Identity of the remark most recently *served* to the UI, written when it
  -- is served. `dismiss_level_observation` only receives an outcome string,
  -- and for the "applied" outcome the frontend has already written the new
  -- cefr_level by the time it arrives — so recomputing at dismissal time
  -- would name a different remark, or none. Recording it at serve time is
  -- the only point where what the reader is looking at is still knowable.
  last_shown_kind TEXT,
  last_shown_band INTEGER,
  last_shown_at   INTEGER,
  updated_at      INTEGER NOT NULL
);

INSERT OR IGNORE INTO level_observation_state (id, stopped, updated_at)
VALUES (1, 0, 0);

-- One row per "keep"/"apply", holding which remark was dismissed. Append-only
-- rather than a mutable last-dismissal row: the suppression window is per
-- remark identity, so two different verdicts dismissed a month apart have to
-- be able to expire independently.
CREATE TABLE IF NOT EXISTS level_observation_dismissals (
  id         TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL CHECK (outcome IN ('applied', 'kept')),
  -- The kind/band of the remark that was on screen. NULL band is legitimate:
  -- a remark can be produced with no band attached.
  kind       TEXT NOT NULL,
  band       INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_level_observation_dismissals_recent
  ON level_observation_dismissals(created_at DESC);
