/**
 * Whether the page has to move for the sentence that is about to be spoken.
 *
 * The audio drives the page: a sentence the reader cannot see is one they are
 * listening to blind, so the reader turns to it. The one thing that outranks
 * that is the reader's own hand — once they page away during playback, the app
 * stops following until playback comes back to what they are looking at.
 *
 * Kept out of the DOM deliberately. The obvious way to ask "is this sentence on
 * screen" is to measure its rect against the frame it lives in, and that is
 * exactly the measurement that cannot be made: Foliate columnises a section into
 * one long horizontal strip and sizes the iframe to the *whole strip*, then
 * scrolls the strip's container to show one page of it. Every sentence in the
 * loaded section therefore sits inside the frame's own viewport, and no rect
 * comparison against it can tell page one from page five. Boundary-point signs
 * against the paginator's own visible range have no such blind spot.
 */

/** One sentence's position relative to the page the reader can see. */
export interface SentencePlacement {
  /** Sign of (sentence start − visible range end). */
  startVsVisibleEnd: number;
  /** Sign of (sentence end − visible range start). */
  endVsVisibleStart: number;
}

export type FollowDecision =
  /** Some of this sentence is on the page already; leave the view alone. */
  | "visible"
  /** It is off the page and nothing forbids moving: navigate to it. */
  | "turn"
  /**
   * It is off the page, but the reader put the page there by hand. Say nothing
   * and let the audio run on: following resumes by itself the first time a
   * sentence lands back inside what they are looking at.
   */
  | "hold";

/**
 * `placement` is `null` when the sentence cannot be placed against the current
 * page at all — it belongs to a section that is not loaded, or the live document
 * has moved on since the visible range was measured. That is not evidence of
 * visibility, so it counts as off the page.
 *
 * Overlap is strict at both ends: a sentence that ends exactly where the page
 * begins, or begins exactly where the page ends, has nothing on screen.
 */
export function decideFollow(
  placement: SentencePlacement | null,
  readerTurnedAway: boolean,
): FollowDecision {
  const visible = placement !== null
    && placement.startVsVisibleEnd < 0
    && placement.endVsVisibleStart > 0;
  if (visible) return "visible";
  return readerTurnedAway ? "hold" : "turn";
}

/**
 * Relocation reasons the reader did not cause. Everything else the paginator
 * reports — a page turn, a swipe snap, a scroll — is their hand on the book.
 *
 * `anchor` is in this list because it is what a reflow emits: resizing the
 * window or dragging a panel re-lays the section out around the same anchor, and
 * that must not read as the reader walking away from the voice.
 */
const AUTOMATIC_RELOCATIONS = new Set(["navigation", "selection", "anchor"]);

export function isReaderRelocation(reason: unknown): boolean {
  return typeof reason !== "string" || !AUTOMATIC_RELOCATIONS.has(reason);
}
