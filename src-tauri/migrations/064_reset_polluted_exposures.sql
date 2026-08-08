-- Clears the vocabulary evidence that was accumulated while the pace filter
-- could not tell reading from page-turning.
--
-- Why. Until the absolute pace gate landed alongside this migration
-- (`mastery::ABSOLUTE_MAX_WPM`), the only speed exclusion was relative: three
-- times the reader's own median. That baseline is drawn from the same screens
-- it exists to police, so page-turns inflated it and the inflated gate then
-- waved more page-turns through. Measured on a real device before the fix:
-- 87.7% of screens were faster than any human reads with comprehension, the
-- median sat at 5627 wpm, and the resulting gate at 16882 wpm excluded 10.8%
-- of screens. Every screen that passed credited *all* of its words as
-- "encountered and not looked up" — positive evidence of knowing them. A
-- screen showing 189 words for 1.8 seconds was being recorded as evidence the
-- reader knows those 189 words.
--
-- What is cleared, and what is deliberately not.
--
--   reading_word_exposures  — all rows. Cleared rather than filtered because
--       the rows are running per-(book, chapter, word) totals: they do not
--       retain which screen each encounter came from, so the contaminated
--       share cannot be subtracted out.
--
--   mastery_progress        — all rows. Purely derived scoring state (credit
--       accrued toward the next tier), recomputed from evidence going
--       forward.
--
--   mastery_events          — only source = 'auto'. The 'review' rows are the
--       outcomes of spaced-repetition reviews the reader actually sat, and
--       'manual' rows are tier changes they made themselves. Neither derives
--       from exposure data and neither is recoverable. They stay.
--
--   vocab_words             — only rows whose tier was set automatically
--       (mastery_source = 'auto') are rolled back to the 'new' default. 038
--       introduced mastery_source precisely so that a miscalibrated automatic
--       scorer could be rolled back without touching what the reader decided.
--       Only the tier columns are touched: fsrs_stability, fsrs_difficulty,
--       next_review_at, review_interval_days, last_reviewed_at,
--       last_review_rating and review_count are left exactly as they are, so
--       no review schedule moves.
--
-- What is NOT touched: reading_screen_dwells. Those rows are the raw record
-- of what actually happened — honest data, wrongly *interpreted* rather than
-- wrongly collected — and they are the only basis on which the corrected
-- median can be computed. Deleting them would destroy the evidence that
-- diagnosed this in the first place.
--
-- Not recoverable. reading_screen_dwells stores word_count but not the words
-- themselves, so the exposure rows cannot be rebuilt from it. This is
-- accepted: the rows being deleted are, by measurement, overwhelmingly false.
--
-- Sync. reading_word_exposures (037), mastery_progress and mastery_events
-- (038, 039) are all device-local by design and never enter the sync
-- container, so clearing them emits no deletion events and cannot propagate.
-- vocab_words *is* synced, so the rollback below does write. It is scoped to
-- automatically-scored rows and stamps updated_by_device = 'migration', the
-- same sentinel the column already defaults to for migration-authored
-- writes.

DELETE FROM reading_word_exposures;

DELETE FROM mastery_progress;

DELETE FROM mastery_events WHERE source = 'auto';

UPDATE vocab_words
   SET mastery = 'new',
       mastery_source = 'manual',
       mastery_reason = NULL,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       updated_by_device = 'migration'
 WHERE mastery_source = 'auto';
