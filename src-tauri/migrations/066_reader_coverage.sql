-- Migration 066 — reader-relative coverage.
-- See docs/impls/handoff-coverage-and-aliases.md §2.4 (a) and (b).
--
-- What this is for. `book_difficulty` (041) answers "how rare is this book's
-- vocabulary", by banding every word against a frequency table. That number
-- has no reader in it: bands 1–5 are the whole table, so the "band 5
-- cumulative coverage" it reports measures how much of the book our dictionary
-- happens to contain. Nation's 95% / 98% reading thresholds have a different
-- subject — *the reader* knows 95% of the running words — and to compute that
-- we need two things this schema did not have: the book's own word list, and
-- somewhere to keep the answer.
--
-- Neither table syncs. Both are derived on-device from a local file and a
-- device-local vocabulary profile (`reading_word_exposures` and
-- `mastery_progress` never leave the machine), so a second device cannot
-- legitimately hold the same values and shipping them through the event log
-- would only add conflict surface. Same reasoning as 041's own comment.

-- The book's word list: one row per distinct form, with how many times it
-- occurs. Already computed on every difficulty pass — `count_words()` builds
-- exactly this map and today throws it away after folding it onto six band
-- counters — so filling this table costs one batch insert, not a second walk
-- through the book.
--
-- `capitalized` is what makes the proper-noun rule computable later. The
-- tokenizer lowercases, so by the time a form reaches this table its casing is
-- gone; storing how many of its occurrences began with a capital lets the
-- coverage pass ask "was this form *only* ever capitalized" without reopening
-- the file. A recurring character name answers yes; an ordinary word that
-- happened to start a sentence answers no, because it also appears mid-sentence
-- somewhere in a whole book.
--
-- Keyed on the same `source_sha256` as `book_difficulty`, so a re-import or an
-- OCR rerun invalidates the word list and the band counts together.
CREATE TABLE IF NOT EXISTS book_word_counts (
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word          TEXT NOT NULL,
  tokens        INTEGER NOT NULL DEFAULT 0,
  capitalized   INTEGER NOT NULL DEFAULT 0,
  source_sha256 TEXT,
  PRIMARY KEY (book_id, word)
) WITHOUT ROWID;

-- The answer: one row per book. Token counts rather than percentages, because
-- the interface needs several ratios out of the same four numbers (with
-- "familiar" counted as known and without it — the 04 state shows both ends as
-- a range) and a stored percentage would have to pick one of them.
--
-- The profile-side counts (`mastered_forms`, `familiar_forms`,
-- `baseline_books`, `profile_at`) describe the vocabulary profile this row was
-- computed against, and are stored rather than re-read at display time for one
-- specific state: while a recomputation runs, the old row stays on screen
-- labelled with the profile it came from ("computed from your July 21
-- profile"). Re-reading today's profile to caption yesterday's number would
-- make that caption a lie.
CREATE TABLE IF NOT EXISTS book_reader_coverage (
  book_id         TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,     -- pending|running|done|failed|unsupported
  -- Book side, as counted for this row. Kept here rather than joined from
  -- `book_difficulty` so the four shares below always sum against the total
  -- they were actually computed from.
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  distinct_words  INTEGER NOT NULL DEFAULT 0,
  -- The four rows of "what this book is made of", in running words.
  mastered_tokens INTEGER NOT NULL DEFAULT 0,
  familiar_tokens INTEGER NOT NULL DEFAULT 0,
  name_tokens     INTEGER NOT NULL DEFAULT 0,
  unknown_tokens  INTEGER NOT NULL DEFAULT 0,
  -- Distinct forms behind the last two, for "4 908 forms / 17 423 tokens".
  name_words      INTEGER NOT NULL DEFAULT 0,
  unknown_words   INTEGER NOT NULL DEFAULT 0,
  -- Reader side: how big the profile was, and how much of it is settled.
  mastered_forms  INTEGER NOT NULL DEFAULT 0,
  familiar_forms  INTEGER NOT NULL DEFAULT 0,
  baseline_books  INTEGER NOT NULL DEFAULT 0,
  profile_at      TEXT,
  source_sha256   TEXT,
  computed_at     TEXT,
  error           TEXT
);
