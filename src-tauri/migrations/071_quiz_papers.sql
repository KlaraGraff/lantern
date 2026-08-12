-- Quiz-scroll (词卷) merge: two tables for the vocab-review quiz feature.
-- See docs/impls/cijuan-merge.md §二.2 for the full design.
--
-- `quiz_papers` holds one row per generated paper. The body (passages,
-- questions, judged result, ask-thread transcript) stays JSON: a paper is
-- always read and written whole — there is no query that needs a single
-- question or passage out of context — so splitting it into tables would
-- only add joins nothing here ever needs, the same call `learning_card`'s
-- `result_json` already made. `content_json` starts as phase-one output
-- (article + questions + answers, no explanations — see §二.6's two-phase
-- generation) and is overwritten once phase two's explanations land, or once
-- a reader's "补生成" retry fills in what phase two missed.
--
-- `quiz_wrong_words` is a real table, not JSON, because it is queried by
-- `next_due_at`/`cleared` — the due-list a new quiz's "recur" words are drawn
-- from — which a JSON blob cannot index. `word` is stored lowercase and is
-- the sole identity key: "Curb" and "curb" are the same wrong word, matching
-- both `scheduler.ts` (the state machine this table's shape mirrors exactly)
-- and the vocab book's own case-insensitive word identity.
--
-- Timestamps in both tables are ISO-8601 strings, not epoch milliseconds —
-- deliberately, unlike the rest of this schema. The ported scheduler (see
-- `commands::quiz`) compares `next_due_at` against "now" with plain string
-- comparison, exactly as `scheduler.ts` did against Dexie; ISO-8601's
-- lexicographic order matches its chronological order, so the comparison is
-- correct without a parse step, and keeping the on-disk shape identical to
-- the labs/cijuan prototype's is what makes the scheduler.test.ts port a
-- faithful one rather than a reinterpretation.
--
-- Neither table is synced (no `updated_by_device` column, no sync events):
-- a quiz paper is a disposable practice artifact, not durable reading state,
-- and the wrong-word pool is a scheduling aid that rebuilds its own meaning
-- from future quiz attempts even if a device never sees an old entry. FSRS
-- writeback to `vocab_words` (§二.5) is what actually needs to survive and
-- sync — that happens through the existing, already-synced vocab review path.

CREATE TABLE quiz_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'submitted')),
  config_json TEXT NOT NULL,      -- QuizConfig (includes the demo flag)
  words_json TEXT NOT NULL,       -- QuizWord[] (word + origin)
  content_json TEXT NOT NULL,     -- passages + readingQuestions + grammarQuestions
  result_json TEXT,               -- QuizResult, written on submit
  ask_threads_json TEXT           -- AskThread[], saved alongside the paper
);

CREATE INDEX idx_quiz_papers_created_at ON quiz_papers(created_at DESC);

CREATE TABLE quiz_wrong_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,      -- stored lowercase; the identity key
  wrong_count INTEGER NOT NULL,
  first_wrong_at TEXT NOT NULL,
  last_wrong_at TEXT NOT NULL,
  stage INTEGER NOT NULL,         -- 0 | 1, see scheduler's stage comment
  next_due_at TEXT,               -- NULL once cleared
  cleared INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_quiz_wrong_words_due ON quiz_wrong_words(cleared, next_due_at);
