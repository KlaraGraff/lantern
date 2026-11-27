-- Indexes for queries that run on every progress save, every lookup, every
-- saved word and every library page, and that previously scanned whole tables.

-- Reader-wide median pace (`reading_behavior::reader_median_wpm`): ordered by
-- `started_at` with no `book_id`, which the (book_id, started_at) index cannot serve.
CREATE INDEX IF NOT EXISTS idx_reading_screen_dwells_started
  ON reading_screen_dwells(started_at DESC);

-- Cross-book lookup memory (`commands::ai::lookup::lookup_memory`): filters on
-- `normalized_text` alone; every existing index leads with `book_id`.
CREATE INDEX IF NOT EXISTS idx_lookup_records_text_recent
  ON lookup_records(normalized_text, last_looked_up_at DESC);

-- Library-wide `word = ? COLLATE NOCASE` matches (lookup → vocab propagation,
-- global "already saved" checks). Only the per-book variants were indexed.
CREATE INDEX IF NOT EXISTS idx_vocab_words_word_nocase
  ON vocab_words(word COLLATE NOCASE);

-- Default library order (`books::query::list_books`): lets the page stop after
-- LIMIT rows instead of sorting every book, cover blob included.
CREATE INDEX IF NOT EXISTS idx_books_updated
  ON books(updated_at DESC, id);
