-- Local-only reading telemetry and cached AI prose for the reading history.
-- These tables intentionally do not participate in the iCloud event log:
-- usage history and generated prose are device-local, and never alter book
-- content or reading position on another device.
CREATE TABLE reading_sessions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  ended_at INTEGER NOT NULL CHECK(ended_at >= started_at),
  active_seconds INTEGER NOT NULL CHECK(
    active_seconds >= 0 AND active_seconds <= (ended_at - started_at) / 1000
  ),
  -- Stable key used by heartbeat/checkpoint writes. NULL keeps ordinary
  -- append-only session rows independent; non-NULL keys are idempotent.
  checkpoint_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_reading_sessions_book_started
  ON reading_sessions(book_id, started_at DESC);
CREATE INDEX idx_reading_sessions_started
  ON reading_sessions(started_at DESC);
CREATE UNIQUE INDEX idx_reading_sessions_checkpoint
  ON reading_sessions(checkpoint_key)
  WHERE checkpoint_key IS NOT NULL;

CREATE TABLE ai_reading_reviews (
  id TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  scope_book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
  facts_json TEXT NOT NULL,
  narrative TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_ai_reading_reviews_period_scope
  ON ai_reading_reviews(period_start, period_end, COALESCE(scope_book_id, ''));
