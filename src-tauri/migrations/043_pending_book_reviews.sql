-- Migration 043 — read-completion summaries persist, and a failed automatic
-- attempt leaves a mark instead of vanishing.
-- See docs/impls/reading-flow-decisions-2026-08-06.md §3 (and §3.4).
--
-- Two changes:
--
-- 1. A book-scoped review used to be keyed by the exact (period_start,
--    period_end) pair it was generated with. `run_book_finished_analysis`
--    always asks for (first session on this book .. now), so every
--    regeneration carries a different `period_end` and would have landed as
--    a brand-new row instead of overwriting the last one — defeating "the
--    old one is replaced, no version history" before it could ever apply.
--    A book only ever has one review, so it gets its own uniqueness: one row
--    per `scope_book_id`, independent of period. Whole-library reviews
--    (`scope_book_id IS NULL`) are unaffected and keep the old per-period
--    uniqueness — a reader asking for "this year" and "all time" reasonably
--    gets two different reviews.
DROP INDEX idx_ai_reading_reviews_period_scope;

CREATE UNIQUE INDEX idx_ai_reading_reviews_library_period
  ON ai_reading_reviews(period_start, period_end)
  WHERE scope_book_id IS NULL;

-- The old per-period uniqueness let a book collect more than one row: the
-- reading-stats page has both a book picker and a date-range tab, so
-- regenerating the same book's review under "last 30 days" and then "all
-- time" (or on two different days, since the automatic trigger's window is
-- always "first session .. now") produced two rows with the same
-- `scope_book_id`. The index below can't be created until each book is back
-- down to one row, so collapse duplicates first.
--
-- Keep the most recently *updated* row per book: `updated_at` is exactly the
-- column a regeneration bumps, so it names whichever generation the reader
-- last saw on that book's stats card. `created_at` breaks ties between rows
-- saved in the same millisecond, `id` breaks the remaining (practically
-- unreachable) tie. The rows this deletes are real, user-visible narratives
-- with no other copy — this is a one-time data migration to make room for a
-- constraint the app already assumes holds, not a compatibility shim.
DELETE FROM ai_reading_reviews
WHERE scope_book_id IS NOT NULL
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY scope_book_id
               ORDER BY updated_at DESC, created_at DESC, id DESC
             ) AS rn
        FROM ai_reading_reviews
       WHERE scope_book_id IS NOT NULL
    )
    WHERE rn = 1
  );

CREATE UNIQUE INDEX idx_ai_reading_reviews_book_scope
  ON ai_reading_reviews(scope_book_id)
  WHERE scope_book_id IS NOT NULL;

-- 2. Not configured / out of quota / offline / the model itself failing used
-- to end in silence: `run_book_finished_analysis` returned `Ok(false)` and
-- nothing on disk recorded that a summary was owed. One row per book that
-- still needs a first successful generation — written on a failed automatic
-- attempt, deleted the moment any generation for that book succeeds (manual
-- or automatic). The reading-stats page reads this to decide whether that
-- book's slot shows the placeholder card described in the plan; it is never
-- surfaced as a notification, badge, or dot.
CREATE TABLE pending_book_reviews (
  book_id    TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  -- One of the four buckets the manual retry path already shows the reader
  -- (`notConfigured` | `quotaExceeded` | `offline` | `failed`) — the
  -- placeholder card reuses that exact vocabulary rather than inventing a
  -- fifth state.
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
