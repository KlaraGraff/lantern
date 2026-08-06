-- Migration 045 — batching the reader's follow-up questions for offline
-- difficulty classification.
-- See docs/impls/reading-flow-decisions-2026-08-06.md §4.4 and
-- docs/impls/reading-driven-mastery-and-review.md §5.5.
--
-- A "follow-up" here is a specific, narrow thing: a `chat_messages` row the
-- reader typed (role = 'user') that carries a `context` — the passage they
-- were asking about, attached by the reader tapping "ask a follow-up" on a
-- lookup or explain popover. A plain dictionary lookup never touches
-- `chat_messages` at all (that path writes `lookup_records` instead), so
-- nothing here can mistake "looked up a word" for "asked about a sentence".
--
-- Rows are captured one at a time, synchronously, in the same command that
-- already saves the chat message — a local SQLite insert costs nothing
-- worth measuring next to the network round-trip the chat reply itself
-- makes. What never happens inline is the AI call: `difficulty` stays NULL
-- until a background batch of 20-30 accumulated rows runs a single cheap
-- classification pass (`commands::followup_difficulty`). Nothing here reads
-- as "AI call" from the reader's chair — the capture is instant, the
-- classification is unrelated in time to the moment they typed.
--
-- Device-local, deliberately: it is a derived read on this device's own
-- chat history, not new content, and there is nothing here a second device
-- could not recompute from its own copy of the same chats.
CREATE TABLE IF NOT EXISTS followup_questions (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  -- The passage the reader was asking about (`chat_messages.context`) and
  -- the question itself (`chat_messages.content`) — exactly the two things
  -- §5.5 says the classification call is allowed to send.
  passage       TEXT NOT NULL,
  question      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- NULL until a batch run classifies this row. The pair (classified_at,
  -- difficulty) is set together, once, by the same call — this table keeps
  -- no history of reclassification because nothing here ever reclassifies.
  classified_at INTEGER,
  difficulty    TEXT CHECK (difficulty IN ('vocabulary', 'syntax', 'reference', 'cultural')),
  -- Which batch call produced this row's classification, kept only so a
  -- test or a support question can be answered ("did these ride the same
  -- request") without joining against ai_usage_records on time proximity.
  batch_id      TEXT
);

-- The batch job's whole query: "give me the oldest unclassified rows."
CREATE INDEX IF NOT EXISTS idx_followup_questions_pending
  ON followup_questions(created_at) WHERE classified_at IS NULL;

-- Unique so capture is idempotent: `save_chat_message` runs once per typed
-- message under normal use, but a retried command (or an MCP client saving
-- the same message twice) must not count one follow-up as two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_questions_message
  ON followup_questions(message_id);
