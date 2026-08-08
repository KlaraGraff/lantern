/**
 * When the reader-top difficulty strip (`BookReaderDifficultyStrip`) goes
 * away, and when it is allowed to come back.
 *
 * The strip is a greeting, not a panel: it says its piece when you resume a
 * book and then gets out of the way, because the space it occupies is
 * reading space. Three exits, whichever lands first — a few seconds pass,
 * the reader turns the page, or the reader taps the ✕.
 *
 * Kept out of the component so the policy can be tested without a DOM, and
 * so the "don't re-greet on a remount" guard has somewhere to live that
 * survives the component's own lifecycle.
 */

/** Exit (a): how long the strip stays up on its own. Long enough to read
 *  three short lines and glance at the ridge chart; short enough that a
 *  reader who ignores it is not still stepping around it. */
export const AUTO_DISMISS_MS = 6_000;

/** A relocate this soon after mount is the book opening — foliate emits one
 *  (often several) while it lays the first screen out — not the reader
 *  turning a page. Without this the strip would dismiss itself before it was
 *  ever painted. */
export const PAGE_TURN_GRACE_MS = 1_500;

/** How long a dismissal holds. Short enough that re-entering the book later
 *  greets you again, long enough that a spurious remount cannot re-greet you
 *  seconds after you dismissed it. */
export const REARM_MS = 30_000;

const dismissedAt = new Map<string, number>();

export function markDismissed(bookId: string, now: number): void {
  dismissedAt.set(bookId, now);
}

/** Whether the strip may greet this book again. */
export function isRearmed(bookId: string, now: number): boolean {
  const at = dismissedAt.get(bookId);
  return at === undefined || now - at >= REARM_MS;
}

/** Whether a location change is a page turn rather than the initial layout. */
export function isPageTurn(mountedAt: number, now: number): boolean {
  return now - mountedAt >= PAGE_TURN_GRACE_MS;
}

/** Tests only — module state otherwise leaks between cases. */
export function resetDismissals(): void {
  dismissedAt.clear();
}
