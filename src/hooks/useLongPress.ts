import { useEffect, useMemo, useRef } from "react";
import { createLongPressTracker, LONG_PRESS } from "../utils/long-press";

/**
 * Gives an ordinary element the touch spelling of right-click.
 *
 * `onContextMenu` is the whole story under a mouse and reaches nothing under a
 * finger, which is how the shelf's per-book menu — details, mark finished, edit
 * info, add to collection, delete — ended up unreachable on the phone: nine
 * actions with no other entry point anywhere in the app.
 *
 * The decision of what counts as a hold lives in `utils/long-press.ts` and is
 * shared with the reader, so the shelf and the book text agree on the timing to
 * the millisecond. What this adds is the part a React component actually needs:
 * the timer, the listeners, and the click suppression, as props to spread.
 *
 * Coordinates come from the pointer, not the element, so the menu opens under
 * the finger exactly as it opens under the cursor — `BookContextMenu` already
 * flips itself away from the viewport edges.
 *
 * A mouse is excluded inside the tracker rather than here, so a touchscreen
 * laptop does not grow a second, slower way to do what right-click already
 * does.
 */
export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
}

export function useLongPress(onLongPress: (x: number, y: number) => void): LongPressHandlers {
  const tracker = useMemo(() => createLongPressTracker(), []);
  const timerRef = useRef<number | undefined>(undefined);
  // Re-read on every fire instead of closing over the callback: the handlers
  // are memoised for the element's lifetime, and the caller's callback usually
  // is not.
  const callbackRef = useRef(onLongPress);
  useEffect(() => {
    callbackRef.current = onLongPress;
  });

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };
  useEffect(() => clearTimer, []);

  return useMemo<LongPressHandlers>(() => ({
    onPointerDown: (event) => {
      clearTimer();
      if (!tracker.begin({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        isPrimary: event.isPrimary,
        x: event.clientX,
        y: event.clientY,
      })) return;
      const { pointerId, clientX, clientY } = event;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        if (!tracker.hold(pointerId)) return;
        tracker.suppressClick(performance.now());
        callbackRef.current(clientX, clientY);
      }, LONG_PRESS.holdMs);
    },
    onPointerMove: (event) => {
      if (tracker.move(event.pointerId, event.clientX, event.clientY)) clearTimer();
    },
    onPointerUp: () => {
      clearTimer();
      tracker.cancel();
    },
    onPointerCancel: () => {
      clearTimer();
      tracker.cancel();
    },
    // Capture phase, because the click that follows a triggered long press
    // would otherwise open the book underneath the menu that just appeared.
    onClickCapture: (event) => {
      if (!tracker.consumeClick(performance.now())) return;
      event.preventDefault();
      event.stopPropagation();
    },
  }), [tracker]);
}
