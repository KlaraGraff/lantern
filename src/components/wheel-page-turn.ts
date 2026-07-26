export type WheelTurnDirection = "previous" | "next";

export interface WheelPageTurnOptions {
  turn(direction: WheelTurnDirection): void;
  /** Return false to leave the event untouched, such as in scrolling mode. */
  isEnabled?(): boolean;
  /** Travel a gesture must cover before it turns, so jitter never pages. */
  triggerDistance?: number;
  /**
   * Silence that ends a gesture. Momentum events arrive at the display refresh
   * rate — 8ms apart on ProMotion, 16ms at 60Hz — and hold that cadence until
   * the tail stops, so a gap this long means the wheel genuinely went quiet.
   */
  quietMs?: number;
  now?(): number;
}

export interface WheelPageTurnHandler {
  handleWheel(event: WheelEvent): void;
  reset(): void;
}

const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 360;

function normalizedDelta(event: WheelEvent): number {
  const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (event.deltaMode === 1) return dominant * LINE_DELTA_PX;
  if (event.deltaMode === 2) return dominant * PAGE_DELTA_PX;
  return dominant;
}

/**
 * One page per wheel gesture, where a gesture ends only when the event stream
 * falls silent.
 *
 * Reading the delta curve to tell a push apart from its momentum tail does not
 * work: macOS momentum decays far too slowly to separate from a steady hand
 * over any short window, so a decay test tuned to accept real scrolling also
 * accepts most of the tail, and one flick cascades into several pages. Silence
 * is the one signal that is not a judgement call — momentum keeps firing at the
 * display refresh rate right up until it stops, so it can never manufacture a
 * quiet gap, and it can never reverse either.
 *
 * So the latch is absolute: after a turn nothing else in the same gesture can
 * page, whatever the deltas do. The cost is that a second flick launched before
 * the previous tail dies is swallowed rather than risking a double turn.
 */
export function createWheelPageTurnHandler({
  turn,
  isEnabled,
  triggerDistance = 50,
  quietMs = 80,
  now = () => Date.now(),
}: WheelPageTurnOptions): WheelPageTurnHandler {
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let accumulated = 0;
  let fired = false;

  const reset = () => {
    lastEventAt = Number.NEGATIVE_INFINITY;
    accumulated = 0;
    fired = false;
  };

  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    if (isEnabled && !isEnabled()) return;
    event.preventDefault();

    const delta = normalizedDelta(event);
    if (delta === 0) return;

    // The event's own timestamp rather than the clock now: rendering the page
    // turn can block the main thread past quietMs, and reading the clock here
    // would score that stall as silence and unlatch the gesture mid-tail.
    const timestamp = Number.isFinite(event.timeStamp) ? event.timeStamp : now();
    const idle = timestamp - lastEventAt > quietMs;
    lastEventAt = timestamp;
    if (idle) {
      accumulated = 0;
      fired = false;
    }
    if (fired) return;

    // Within a live gesture a sign flip is the hand changing its mind before
    // the page turned, not a new gesture — momentum cannot reverse.
    if (accumulated !== 0 && Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    accumulated += delta;
    if (Math.abs(accumulated) < triggerDistance) return;

    fired = true;
    turn(accumulated > 0 ? "next" : "previous");
  };

  return { handleWheel, reset };
}
