-- Migration 056 — per-section band tallies behind the book_difficulty row.
-- See src-tauri/src/commands/book_difficulty.rs.
--
-- book_difficulty (migration 041) has always thrown this away: computing it
-- walks the book section by section — extract_source_text returns one
-- SectionText per EPUB spine item (or per text-book TOC entry) — and only
-- the sum across every section was ever written down. The per-section pass
-- was already paid for; this table just keeps what it produced instead of
-- discarding it at the merge step.
--
-- Same non-sync posture as book_difficulty: deterministic, recomputable from
-- the file in seconds, so shipping it through the event log would only add
-- conflict surface for no benefit. A recompute deletes a book's rows here
-- and reinserts fresh ones — there is no history to preserve, and a
-- shorter re-import must not leave higher-numbered rows behind from a
-- longer previous version of the file.
--
-- chapter_title is deliberately nullable and never a machine-generated
-- placeholder ("Section 3"). It holds a real title only when one is
-- actually recoverable — an EPUB spine item matched against the book's own
-- nav TOC, or (failing that) the item's own first heading — and NULL
-- otherwise: a front-matter section (copyright page, half-title) has
-- neither. PDF sections are skipped from this table entirely, not merely
-- left title-less: extract_pdf's "sections" are pages, not chapters, so a
-- novel-length PDF would turn into hundreds of rows under a machine label
-- ("Page 12") this column exists to refuse. PDF keeps only the whole-book
-- aggregate it already had.
CREATE TABLE book_difficulty_sections (
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- 0-based position among the sections this book actually produced text
  -- for (extraction already drops spine items with no readable blocks), in
  -- reading order.
  section_order  INTEGER NOT NULL,
  chapter_title  TEXT,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  band1          INTEGER NOT NULL DEFAULT 0,
  band2          INTEGER NOT NULL DEFAULT 0,
  band3          INTEGER NOT NULL DEFAULT 0,
  band4          INTEGER NOT NULL DEFAULT 0,
  band5          INTEGER NOT NULL DEFAULT 0,
  band_unlisted  INTEGER NOT NULL DEFAULT 0,
  -- The file version these numbers were computed from — same value as the
  -- book_difficulty row written alongside them in the same pass.
  source_sha256  TEXT,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (book_id, section_order)
);
