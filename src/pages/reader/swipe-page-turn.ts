/**
 * When a finger dragged across the page counts as "turn to the next page".
 *
 * The reader already turns pages from a wheel, a key and a mouse binding
 * (`wheel-page-turn.ts`, `keyboard-page-turn.ts`, `reader-bindings.ts`), and
 * every one of those needs hardware a phone does not have. Swipe is the touch
 * spelling of the same command, and like the others it is arithmetic over a few
 * facts about the gesture — so it lives here, framework-free and DOM-free, and
 * the document listeners in `useReaderInteractions.ts` only feed it events.
 *
 * The hard part is not recognising a swipe. It is refusing to recognise the
 * three other things a finger does on this exact surface:
 *
 * - **A long press.** `long-press.ts` opens the selection menu after 500 ms
 *   within 10 px. A swipe travels much further, so the two look disjoint — but
 *   only for a fast swipe. A finger that rests, opens the menu, and *then*
 *   drags would otherwise turn the page out from under the menu it just
 *   opened. `cancel()` exists for that: the long-press timer calls it when it
 *   fires, and this gesture is dead for the rest of the pointer's life.
 * - **Scrolling.** In continuous flow the reading motion is vertical, and a
 *   thumb travelling down the glass wanders sideways as it goes. Hence the
 *   dominance test rather than a bare horizontal threshold: a gesture must be
 *   twice as horizontal as it is vertical, measured over the whole travel.
 * - **Selecting text, and dragging a selection handle.** Both are horizontal by
 *   nature and would otherwise page constantly. The caller decides this one —
 *   it knows whether a selection exists and what was under the finger — and
 *   says so by not beginning a gesture, or by cancelling one.
 *
 * Not handled: right-to-left books, where a reader would expect the directions
 * mirrored. Nothing else in the reader's page-turn input is RTL-aware either
 * (the wheel handler maps positive delta to "next" unconditionally), so doing
 * it here alone would make swipe disagree with the wheel on the same book. It
 * is one flag away if RTL support is ever taken on as a whole.
 */

export type SwipeDirection = "previous" | "next";

export interface SwipePageTurnConfig {
  /** Horizontal travel that turns a page outright, however slow the drag. */
  triggerDistancePx: number;
  /**
   * Shorter travel that still turns a page when it happened fast enough. A
   * flick is a complete gesture at 30 px; requiring the full distance would
   * make the reader drag deliberately every time, which is not what a finger
   * flicking through a book is doing.
   */
  flickDistancePx: number;
  /** How quickly `flickDistancePx` has to be covered to count as a flick. */
  flickWithinMs: number;
  /**
   * How much more horizontal than vertical the travel must be. 2 is a ±26.6°
   * cone either side of level — wide enough for the arc a thumb pivoting from
   * the base of the hand actually draws, narrow enough that a scroll aimed
   * down the page never enters it.
   */
  dominanceRatio: number;
  /** Floor between two turns, so one continuous drag cannot cascade. */
  minTurnGapMs: number;
}

export const SWIPE_PAGE_TURN: SwipePageTurnConfig = {
  triggerDistancePx: 60,
  flickDistancePx: 30,
  flickWithinMs: 250,
  dominanceRatio: 2,
  minTurnGapMs: 300,
};

/** The parts of a `PointerEvent` the decision reads. */
export interface SwipePointer {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  button: number;
  x: number;
  y: number;
}

/**
 * Whether this pointer may start a swipe at all.
 *
 * Touch only — not pen, not mouse. A mouse drag across text is a selection and
 * always has been; a pen drag on a tablet is writing or selecting for the same
 * reason. Both of those devices also have every other way to turn a page.
 * Primary button of a primary pointer, so a second finger landing mid-gesture
 * (the start of a pinch) cannot open a swipe of its own.
 */
export function swipePointerEligible(pointer: {
  pointerType: string;
  isPrimary: boolean;
  button: number;
}): boolean {
  return pointer.pointerType === "touch" && pointer.isPrimary && pointer.button === 0;
}

/**
 * Which way a completed travel points, or null if it is not a swipe.
 *
 * Swiping left pulls the next page in from the right, the direction the text
 * itself moves. Exported separately from the tracker because it is the whole
 * geometric decision and deserves to be testable without a gesture around it.
 */
export function swipeDirection(
  dx: number,
  dy: number,
  elapsedMs: number,
  config: SwipePageTurnConfig = SWIPE_PAGE_TURN,
): SwipeDirection | null {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (horizontal < config.flickDistancePx) return null;
  // Strictly greater, so a perfectly diagonal 45° drag — genuinely ambiguous —
  // resolves to "not a swipe" rather than to whichever axis rounding favours.
  if (horizontal <= vertical * config.dominanceRatio) return null;
  const far = horizontal >= config.triggerDistancePx;
  const flicked = elapsedMs <= config.flickWithinMs;
  if (!far && !flicked) return null;
  return dx < 0 ? "next" : "previous";
}

export type SwipePhase = "idle" | "tracking" | "cancelled" | "turned";

export interface SwipeTracker {
  /** Current phase — read by tests and assertions, not by logic. */
  readonly phase: SwipePhase;
  /**
   * A pointer went down. Returns whether it is worth tracking; a caller that
   * gets false can forget about this pointer entirely.
   */
  begin(pointer: SwipePointer, now: number): boolean;
  /**
   * A pointer moved. Returns the direction to turn, or null. Returning a
   * direction latches the gesture: one drag turns one page, no matter how far
   * the finger keeps going, because a reader who wanted three pages would have
   * swiped three times.
   */
  move(pointerId: number, x: number, y: number, now: number): SwipeDirection | null;
  /**
   * Whatever else this pointer turned out to be — a long press that fired, a
   * selection the caller found under the finger, a pointercancel from the OS
   * taking the gesture over — it is not a swipe. Idempotent.
   */
  cancel(pointerId?: number): void;
}

export function createSwipeTracker(
  config: SwipePageTurnConfig = SWIPE_PAGE_TURN,
): SwipeTracker {
  let phase: SwipePhase = "idle";
  let pointerId: number | null = null;
  let start: { x: number; y: number } | null = null;
  let startedAt = 0;
  let lastTurnAt = Number.NEGATIVE_INFINITY;

  return {
    get phase() {
      return phase;
    },
    begin(pointer, now) {
      if (!swipePointerEligible(pointer)) {
        phase = "idle";
        pointerId = null;
        start = null;
        return false;
      }
      phase = "tracking";
      pointerId = pointer.pointerId;
      start = { x: pointer.x, y: pointer.y };
      startedAt = now;
      return true;
    },
    move(id, x, y, now) {
      if (phase !== "tracking" || id !== pointerId || !start) return null;
      const direction = swipeDirection(x - start.x, y - start.y, now - startedAt, config);
      if (!direction) return null;
      // Latch before the rate check, not after: a drag that earned a turn is
      // spent either way. Otherwise a finger held past the cooldown would fire
      // again without ever lifting.
      phase = "turned";
      if (now - lastTurnAt < config.minTurnGapMs) return null;
      lastTurnAt = now;
      return direction;
    },
    cancel(id) {
      if (id !== undefined && pointerId !== null && id !== pointerId) return;
      phase = phase === "turned" ? "turned" : "cancelled";
      pointerId = null;
      start = null;
    },
  };
}
