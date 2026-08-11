/**
 * When a press-and-hold counts as "open the context menu here".
 *
 * A finger has no second button, so everything Lantern hangs off `contextmenu`
 * — the reader's selection menu and the free dictionary strip behind it
 * (`dictionary-glance.ts`), the shelf's per-book menu — was unreachable by
 * touch. Long press is the touch spelling of that gesture. Whether a given
 * press qualifies is arithmetic over three facts (which pointer, how far it
 * travelled, how long it stayed), so it lives here rather than tangled into
 * the listeners of whichever surface needs it — the same split
 * `dictionary-glance.ts` and `learning-card/placement.ts` already use.
 *
 * Framework-free and DOM-free on purpose: the caller owns the timer and the
 * events, this owns the decision. `hooks/useLongPress.ts` is the React
 * wrapper that owns both for an ordinary element; the reader drives the
 * tracker itself because its listeners are on the book's iframe document.
 */

export interface LongPressConfig {
  /** How long the finger has to stay down before the menu opens. */
  holdMs: number;
  /** Travel that reclassifies the press as a drag (scroll, or a selection). */
  moveTolerancePx: number;
  /** How long after a triggered long press a synthetic click is ignored. */
  clickSuppressionMs: number;
}

/**
 * 500 ms / 10 px.
 *
 * 500 ms is the platform long-press feel on both iOS and Android, and it sits
 * clear of the 150 ms the selection menu already waits after a drag ends — a
 * reader who lifts a finger has long since stopped holding it.
 *
 * 10 px rather than the 8 px `SortableList` uses to tell a click from a drag:
 * that one arbitrates between two things the same finger meant to do, while
 * this one only has to survive the tremor of a finger that is deliberately
 * still. A finger resting on glass wanders further than a mouse ever does, and
 * every pixel of tolerance here is a pixel a scroll or a selection drag has to
 * cover before it is recognised — 10 px is under one line of body text either
 * way.
 *
 * 700 ms of click suppression covers the pointerup→click latency on a slow
 * frame with room to spare. It is time-bounded rather than a flag waiting to
 * be consumed because WebKit does not always send a `click` after a press that
 * ended with a selection on screen: a flag alone would survive into the next
 * gesture and swallow a tap the reader meant.
 */
export const LONG_PRESS: LongPressConfig = {
  holdMs: 500,
  moveTolerancePx: 10,
  clickSuppressionMs: 700,
};

/** The parts of a `PointerEvent` the decision reads. */
export interface LongPressPointer {
  pointerId: number;
  pointerType: string;
  button: number;
  isPrimary: boolean;
  x: number;
  y: number;
}

/**
 * Whether this pointer may start a long press at all.
 *
 * Two exclusions, both structural rather than tuned:
 *
 * - A mouse is out, whatever the media query says about the device. A mouse
 *   already has `contextmenu`, and a coarse-pointer machine that also has a
 *   trackpad must not grow a second, slower way to do the same thing.
 * - Only the primary button of a primary pointer. Page-turn mouse bindings can
 *   only ever name a non-primary button (`bindingFromMouseEvent` returns null
 *   for button 0), so restricting long press to button 0 makes the two
 *   gestures disjoint by construction, not by ordering luck.
 */
export function longPressPointerEligible(pointer: {
  pointerType: string;
  button: number;
  isPrimary: boolean;
}): boolean {
  if (pointer.pointerType === "mouse") return false;
  return pointer.button === 0 && pointer.isPrimary;
}

/** Whether the pointer has wandered far enough to stop being a hold. */
export function longPressTravelExceeded(
  start: { x: number; y: number },
  x: number,
  y: number,
  moveTolerancePx: number = LONG_PRESS.moveTolerancePx,
): boolean {
  return Math.hypot(x - start.x, y - start.y) >= moveTolerancePx;
}

export type LongPressPhase = "idle" | "pending" | "cancelled" | "triggered";

export interface LongPressTracker {
  /** Current phase — read by tests and by the caller's assertions, not by logic. */
  readonly phase: LongPressPhase;
  /**
   * A pointer went down. Resets everything this tracker remembers (including
   * any armed click suppression) and reports whether a hold timer is worth
   * scheduling.
   */
  begin(pointer: LongPressPointer): boolean;
  /**
   * A pointer moved. Returns whether *this* move called the hold off, so the
   * caller can drop its timer — a move by any other pointer (a second finger,
   * a stylus resting on the glass) is not this press's business and answers
   * false without touching it.
   */
  move(pointerId: number, x: number, y: number): boolean;
  /**
   * The hold timer fired. Returns whether it fired on a press that is still a
   * candidate — a different pointer, a cancelled press, or a press that
   * already ended all answer false.
   */
  hold(pointerId: number): boolean;
  /** The gesture opened something; ignore the click that may follow. */
  suppressClick(now: number): void;
  /** A click arrived. Returns whether it belongs to a long press just handled. */
  consumeClick(now: number): boolean;
  /** The pointer came up, or the press was abandoned. */
  cancel(): void;
}

export function createLongPressTracker(
  config: LongPressConfig = LONG_PRESS,
): LongPressTracker {
  let phase: LongPressPhase = "idle";
  let pointerId: number | null = null;
  let start: { x: number; y: number } | null = null;
  let suppressClickUntil = 0;

  return {
    get phase() {
      return phase;
    },
    begin(pointer) {
      suppressClickUntil = 0;
      if (!longPressPointerEligible(pointer)) {
        phase = "idle";
        pointerId = null;
        start = null;
        return false;
      }
      phase = "pending";
      pointerId = pointer.pointerId;
      start = { x: pointer.x, y: pointer.y };
      return true;
    },
    move(id, x, y) {
      if (phase !== "pending" || id !== pointerId || !start) return false;
      if (!longPressTravelExceeded(start, x, y, config.moveTolerancePx)) return false;
      phase = "cancelled";
      return true;
    },
    hold(id) {
      if (phase !== "pending" || id !== pointerId) return false;
      phase = "triggered";
      return true;
    },
    suppressClick(now) {
      suppressClickUntil = now + config.clickSuppressionMs;
    },
    consumeClick(now) {
      if (now >= suppressClickUntil) return false;
      suppressClickUntil = 0;
      return true;
    },
    cancel() {
      // The click guard deliberately survives: the pointerup that ends a
      // triggered long press is exactly what arms it, and the click it is
      // guarding against has not arrived yet.
      phase = phase === "triggered" ? "triggered" : "idle";
      pointerId = null;
      start = null;
    },
  };
}
