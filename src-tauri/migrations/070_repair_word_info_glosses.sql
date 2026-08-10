-- Repairs the words whose annotation in the book is a morphology blob.
--
-- Why. `vocab_words.definition` is one short line, printed over the word as a
-- ruby or margin gloss. Every lookup drops the word into the observation zone
-- (`observe_lookup_for_vocab`), which copies the lookup record's `definition`
-- into that column verbatim — and the frontend was filling the lookup record
-- from the whole `word_info` module: spelling, pronunciation, part of speech,
-- affixes, four lines of it. The reader saw its first line hanging over the
-- word ("reuniting 是 reunite 的现在分词形式") where the contextual sense
-- ("与家人重聚") belonged. `projection()` now stores the contextual gloss;
-- this repairs the rows written before it did.
--
-- What is repaired. Only rows where the blob is unmistakable *and* the right
-- answer is already on hand:
--
--   * the definition is multi-line or far too wide to sit over a word — the
--     two structural signals `vocab_regloss::looks_like_card_blob` uses, kept
--     structural on purpose so a Chinese reader's rows and an English
--     reader's are treated the same;
--   * `context_explanation` exists, and its first line is the contextual
--     sense the card put there (the prompt's two-part contract writes exactly
--     that line first);
--   * that first line is short enough to be a gloss rather than a sentence.
--
-- A row failing any of those is left exactly as it is: the reader can press
-- regenerate, which now writes the right column, and inventing a gloss out of
-- an unknown blob would be worse than the blob.
--
-- Nothing is lost either way. The blob itself was only ever a copy of the
-- card's own modules, and the card is still in `card_snapshot` /
-- `result_json` where it was.
--
-- Sync. `vocab_words` is synced, so this writes; it stamps
-- `updated_by_device = 'migration'`, the sentinel 064 already uses for
-- migration-authored writes. `lookup_records` are device-local history.

UPDATE vocab_words
   SET definition = TRIM(
           CASE
             WHEN INSTR(context_explanation, CHAR(10)) > 0
               THEN SUBSTR(context_explanation, 1, INSTR(context_explanation, CHAR(10)) - 1)
             ELSE context_explanation
           END
       ),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       updated_by_device = 'migration'
 WHERE (definition LIKE '%' || CHAR(10) || '%' OR LENGTH(definition) > 32)
   AND context_explanation IS NOT NULL
   AND LENGTH(TRIM(
           CASE
             WHEN INSTR(context_explanation, CHAR(10)) > 0
               THEN SUBSTR(context_explanation, 1, INSTR(context_explanation, CHAR(10)) - 1)
             ELSE context_explanation
           END
       )) BETWEEN 1 AND 30;

UPDATE lookup_records
   SET definition = TRIM(
           CASE
             WHEN INSTR(context_explanation, CHAR(10)) > 0
               THEN SUBSTR(context_explanation, 1, INSTR(context_explanation, CHAR(10)) - 1)
             ELSE context_explanation
           END
       ),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE (definition LIKE '%' || CHAR(10) || '%' OR LENGTH(definition) > 32)
   AND context_explanation IS NOT NULL
   AND LENGTH(TRIM(
           CASE
             WHEN INSTR(context_explanation, CHAR(10)) > 0
               THEN SUBSTR(context_explanation, 1, INSTR(context_explanation, CHAR(10)) - 1)
             ELSE context_explanation
           END
       )) BETWEEN 1 AND 30;
