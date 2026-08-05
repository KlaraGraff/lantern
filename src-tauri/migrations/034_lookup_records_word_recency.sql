-- Contextual review recovers "which chapter was this word from" by looking the
-- word up in lookup history. The exact-position lookup rides the existing
-- unique index on (book_id, cfi, normalized_text); the fall back to "most
-- recent lookup of this word anywhere in the book" had no index whose middle
-- column it could skip, so it scanned and sorted every lookup row in the book
-- once per vocabulary word. This index makes that seek-and-stop.
CREATE INDEX IF NOT EXISTS idx_lookup_records_word_recent
  ON lookup_records(book_id, normalized_text, last_looked_up_at DESC);
