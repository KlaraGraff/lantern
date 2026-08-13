-- Progressive paper delivery (渐进发卷, docs/impls/quiz-progressive-delivery.md):
-- a paper is now created as soon as its *first* article finishes generating,
-- while the remaining articles keep generating in the background. That needs:
--
-- 1. A third `status` value, 'generating' — the paper exists and is (partly)
--    takeable, but not every article has landed yet. Submit is refused in this
--    state (frontend disables the button; `submit_quiz_paper` guards too).
--    SQLite cannot alter a CHECK constraint, hence the table rebuild.
--
-- 2. `generation_json` — the generation plan: one entry per word group
--    ("article slot"), with each group's words and state
--    (pending/failed/done). Owned and parsed exclusively by the frontend,
--    like the other JSON columns (see src/pages/quiz/paper-io.ts). NULL for
--    non-progressive papers and for papers whose generation completed —
--    a finished paper is byte-for-byte shaped like a pre-072 one.
--
-- Existing rows are copied verbatim: 'ready'/'submitted' remain valid states
-- and old papers have no generation plan (generation_json NULL).

CREATE TABLE quiz_papers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'submitted')),
  config_json TEXT NOT NULL,      -- QuizConfig (includes the demo flag)
  words_json TEXT NOT NULL,       -- QuizWord[]; grows per finished article (per-article coverage settlement)
  content_json TEXT NOT NULL,     -- passages + readingQuestions + grammarQuestions
  result_json TEXT,               -- QuizResult, written on submit
  ask_threads_json TEXT,          -- AskThread[], saved alongside the paper
  generation_json TEXT            -- generation plan while status='generating'; NULL otherwise
);

INSERT INTO quiz_papers_new (id, created_at, status, config_json, words_json, content_json, result_json, ask_threads_json)
  SELECT id, created_at, status, config_json, words_json, content_json, result_json, ask_threads_json
  FROM quiz_papers;

DROP TABLE quiz_papers;
ALTER TABLE quiz_papers_new RENAME TO quiz_papers;

CREATE INDEX idx_quiz_papers_created_at ON quiz_papers(created_at DESC);
