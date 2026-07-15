export type WheelTurnDirection = "previous" | "next";

export interface WheelPageTurnOptions {
  turn(direction: WheelTurnDirection): void;
  /** Return false to leave the event untouched, such as in scrolling mode. */
  isEnabled?(): boolean;
  triggerDistance?: number;
  quietMs?: number;
  now?(): number;
}

export interface WheelPageTurnHandler {
  handleWheel(event: WheelEvent): void;
  reset(): void;
}

const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 360;
const REACCELERATION_FACTOR = 1.5;
const REACCELERATION_MIN_PX = 4;

function normalizedDelta(event: WheelEvent): number {
  const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (event.deltaMode === 1) return dominant * LINE_DELTA_PX;
  if (event.deltaMode === 2) return dominant * PAGE_DELTA_PX;
  return dominant;
}

/** Treat one continuous wheel gesture, including inertia, as at most one page turn. */
export function createWheelPageTurnHandler({
  turn,
  isEnabled,
  triggerDistance = 50,
  quietMs = 250,
  now = () => Date.now(),
}: WheelPageTurnOptions): WheelPageTurnHandler {
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let accumulated = 0;
  let fired = false;
  let lastMagnitude = 0;

  const reset = () => {
    lastEventAt = Number.NEGATIVE_INFINITY;
    accumulated = 0;
    fired = false;
    lastMagnitude = 0;
  };

  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    if (isEnabled && !isEnabled()) return;
    event.preventDefault();

    const delta = normalizedDelta(event);
    const timestamp = now();
    const gapExceeded = timestamp - lastEventAt > quietMs;
    lastEventAt = timestamp;
    if (delta === 0) return;

    const magnitude = Math.abs(delta);
    const reversed = accumulated !== 0 && Math.sign(delta) !== Math.sign(accumulated);
    const reaccelerated = fired
      && !reversed
      && magnitude > lastMagnitude * REACCELERATION_FACTOR + REACCELERATION_MIN_PX;
    if (gapExceeded || reversed || reaccelerated) {
      accumulated = 0;
      fired = false;
    }
    lastMagnitude = magnitude;
    if (fired) return;

    accumulated += delta;
    if (Math.abs(accumulated) < triggerDistance) return;
    fired = true;
    turn(accumulated > 0 ? "next" : "previous");
  };

  return { handleWheel, reset };
}
