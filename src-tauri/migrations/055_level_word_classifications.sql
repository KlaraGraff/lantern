-- Cache of AI word-class verdicts for the level observation's topical
-- screen (docs/impls/level-observation-topical-words.md). One row per
-- (word, book) the classifier has judged. The pair is the key because
-- "topical" is a claim about a word *in a book* — "deck" is a sailing
-- novel's terminology and every other book's ordinary noun.
--
-- No expiry column: a word's relationship to a book's subject matter does
-- not change with time, so a verdict is computed once and read forever.
CREATE TABLE level_word_classifications (
  normalized_word TEXT NOT NULL,
  book_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('topical', 'general')),
  classified_at INTEGER NOT NULL,
  -- Which batch call produced this verdict, for tracing a bad batch.
  batch_id TEXT NOT NULL,
  PRIMARY KEY (normalized_word, book_id)
);
