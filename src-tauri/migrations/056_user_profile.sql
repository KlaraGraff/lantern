-- User profile — see docs/impls/user-profile.md. Two segments feed every
-- card-aware follow-up prompt (wired in a later batch): a free-text segment
-- the reader writes themselves, held in `settings` (`profile.user_text` /
-- `profile.draft_text` / `profile.enabled` / `profile.soft_limit` — no table
-- needed for a single blob of text), and a system segment organised into a
-- fixed set of seven dimensions, one card each, held here.

-- Every dimension's card. Slot is the primary key because the dimension
-- registry (`commands::profile::DIMENSIONS`) is fixed — there is never more
-- than one card per dimension. Rows are never physically deleted: a
-- dimension the reader deleted keeps its row so its `watermark` can keep
-- filtering the aggregation that might one day re-earn it a new card.
CREATE TABLE IF NOT EXISTS profile_cards (
  slot          TEXT PRIMARY KEY,          -- dimension key, see the registry
  conclusion    TEXT NOT NULL,             -- goes in the prompt; free sentence
  evidence      TEXT NOT NULL DEFAULT '',  -- never goes in the prompt
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','moved','deleted')),
  inserted_text TEXT,                      -- snapshot of what moving inserted into user_text; undo removes this exact text
  watermark     INTEGER,                   -- timestamp of the last delete; aggregation excludes created_at <= watermark
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Append-only ledger of every correction the reader made to a card: delete,
-- move, undo (of a move), an automatic rewrite, or a future effect signal.
-- Never read into a prompt directly (docs/impls/user-profile.md's "修正信号
-- 三层" — raw ledger, then a code-only adjudication pass, then a single
-- derived line per dimension); this table is the raw material for both that
-- adjudication and, eventually, the self-learning hooks in the same doc's
-- Appendix B.
CREATE TABLE IF NOT EXISTS profile_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slot       TEXT,                          -- NULL for a whole-profile event
  event_type TEXT NOT NULL CHECK(event_type IN ('delete','move','undo','rewrite','effect')),
  user_text  TEXT,                          -- the reader's own wording, for rewrite/move
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_events_slot ON profile_events(slot, created_at);

-- One row per summarizer run: the whole active-card set before and after.
-- The ground floor for effect attribution (Appendix B item 1) — without a
-- record of what changed and when, nothing downstream can ever say whether
-- a rebuild helped.
CREATE TABLE IF NOT EXISTS profile_revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cards_before TEXT NOT NULL,               -- JSON: every active card, full text, before this run
  cards_after  TEXT NOT NULL,               -- JSON: same, after
  reason       TEXT NOT NULL,               -- 'batch' | 'manual'
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_revisions_created ON profile_revisions(created_at DESC);
