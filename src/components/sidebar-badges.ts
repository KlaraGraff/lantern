/**
 * Which memo row, if any, gets a due-review count badge.
 *
 * An allowlist rather than an exclusion: only "vocab" ever shows a count.
 * See docs/impls/review-entry-mockup.html §1 (RED LINE) — the review entry
 * (the 回顾 board at the top of the words page; it lost its duplicate sidebar
 * row in docs/impls/home-ia-consolidation.md step 1) is a workspace, not a
 * notification bell, and must never carry a count/badge/dot of its own. The
 * words row, by contrast, is exactly where a reader checking "how much is
 * queued" would look, the same way a deck's name carries its due count in a
 * flashcard app.
 */
export function memoRowBadgeCount(filterId: string, dueForReviewCount: number): number | null {
  if (filterId !== "vocab") return null;
  if (!Number.isFinite(dueForReviewCount) || dueForReviewCount <= 0) return null;
  return dueForReviewCount;
}
