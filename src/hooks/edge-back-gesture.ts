/**
 * Gesture constants for BookDetails' left-edge swipe-to-go-back.
 *
 * Same shape as `useDrawerGesture.ts` and the same numbers — one direction
 * lock, one claim threshold, one flick-vs-position settle — because that
 * controller is the proven answer in this codebase to "recognise a horizontal
 * drag from the edge without stealing a vertical scroll", and there is no
 * reason for BookDetails to feel different under a thumb than the shelf does.
 * What differs is the shape of the outcome: the drawer flips a persistent
 * open/closed flag, but a page only ever leaves once. There is no "open"
 * state here — a completed gesture is either a `"back"` or a `"cancelled"`,
 * reported once, and the controller has nothing left to remember afterwards.
 */
export const EDGE_BACK_ZONE_PX = 20;
export const EDGE_BACK_VERTICAL_LOCK_PX = 8;
export const EDGE_BACK_DIRECTION_DOMINANCE = 1.5;
export const EDGE_BACK_POSITION_THRESHOLD = 0.5;
export const EDGE_BACK_FLICK_VELOCITY_PX_PER_MS = 0.5;
/** Only for after the finger leaves; there is no transition during a drag. */
export const EDGE_BACK_SETTLE_MS = 200;

/**
 * No minimum horizontal travel is specified on its own, and one jittery pixel
 * already beats a ratio when vertical movement is zero. The vertical lock
 * distance doubles as horizontal slop so a tap or a hesitant press never
 * nudges the page.
 */
export const EDGE_BACK_HORIZONTAL_CLAIM_PX = EDGE_BACK_VERTICAL_LOCK_PX;

/**
 * Release velocity is measured over the last samples inside this window, not
 * across the whole gesture. A drag that crawls for a second and then flicks
 * is a flick; averaging from first touch to release would read it as a crawl.
 */
export const EDGE_BACK_VELOCITY_WINDOW_MS = 100;

/** Everything the gesture needs from a pointer event, and nothing more. */
export interface EdgeBackPointerInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface EdgeBackGestureState {
  /** 0 = untouched, 1 = fully dismissed. Clamped. */
  fraction: number;
  /** True while the finger owns the position — the component's transition goes on only when false. */
  dragging: boolean;
}

export interface EdgeBackGestureConfig {
  /** Page travel in px, read once per drag. The hook never measures the DOM itself. */
  width: () => number;
  /** Injectable clock, so tests do not need real timers. */
  now?: () => number;
}

/** What a completed drag decided. Reported once per gesture, never for a tap
 *  that lifts before clearing the direction lock. */
export type EdgeBackOutcome = "back" | "cancelled";

type Phase = "idle" | "candidate" | "dragging" | "rejected";

const clampFraction = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * The decision half of the gesture: pointer samples in, an open fraction out.
 * It never touches the DOM and never renders, which is what lets it be tested
 * without a browser. See `useEdgeSwipeBack.ts` for the React wiring.
 */
export class EdgeBackGestureController {
  /** Live position. Readable at any moment without a re-render. */
  readonly fractionRef: { current: number };

  private width: () => number;
  private clock: () => number;
  private dragging = false;

  private phase: Phase = "idle";
  private activePointer: number | null = null;
  private startX = 0;
  private startY = 0;
  private travel = 1;
  private samples: { x: number; t: number }[] = [];

  private frameListeners = new Set<(state: EdgeBackGestureState) => void>();
  private settledListeners = new Set<(outcome: EdgeBackOutcome) => void>();

  constructor(config: EdgeBackGestureConfig) {
    this.width = config.width;
    this.clock = config.now ?? (() => performance.now());
    this.fractionRef = { current: 0 };
  }

  /** Lets a re-rendered component hand over fresh closures without a new controller. */
  configure(config: Pick<EdgeBackGestureConfig, "width" | "now">) {
    this.width = config.width;
    if (config.now) this.clock = config.now;
  }

  readonly getState = (): EdgeBackGestureState => ({
    fraction: this.fractionRef.current,
    dragging: this.dragging,
  });

  /** Fires on every position change, including each pointermove. Not for React state. */
  readonly subscribe = (listener: (state: EdgeBackGestureState) => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  /** Fires exactly once per gesture that clears the direction lock — never for a tap. */
  readonly subscribeSettled = (listener: (outcome: EdgeBackOutcome) => void): (() => void) => {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  };

  /**
   * Returns true when the pointer is worth following. False means the gesture
   * is none of this page's business — do not capture it and do not
   * preventDefault, or the page stops scrolling. A true here is still not a
   * claim: the drag only starts moving once `pointerMove` clears the
   * direction lock.
   */
  readonly pointerDown = (event: EdgeBackPointerInput): boolean => {
    if (this.activePointer !== null) return false;
    if (event.clientX >= EDGE_BACK_ZONE_PX) return false;

    this.phase = "candidate";
    this.activePointer = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.samples = [{ x: event.clientX, t: this.clock() }];
    return true;
  };

  readonly pointerMove = (event: EdgeBackPointerInput): void => {
    if (event.pointerId !== this.activePointer || this.phase === "rejected") return;
    this.pushSample(event.clientX);

    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;

    if (this.phase === "candidate") {
      // The direction lock is one-way and permanent, same reasoning as the
      // drawer's: a finger scrolling the page drifts sideways all the time,
      // and if the gesture could still claim it afterwards a downward flick
      // would leave the shelf under a card that just slid away.
      if (Math.abs(dy) > EDGE_BACK_VERTICAL_LOCK_PX) {
        this.phase = "rejected";
        return;
      }
      if (Math.abs(dx) < EDGE_BACK_HORIZONTAL_CLAIM_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * EDGE_BACK_DIRECTION_DOMINANCE) return;
      // Only a rightward drag is "back" — a finger that clears the slop
      // moving left has nowhere to go (the fraction below would just clamp to
      // 0 forever), so it is rejected outright instead of sitting as a
      // candidate that re-tests every remaining move of the gesture.
      if (dx <= 0) {
        this.phase = "rejected";
        return;
      }
      this.phase = "dragging";
      this.dragging = true;
      this.travel = Math.max(1, this.width());
    }

    // Measured from the original touch point, not from where the claim
    // landed, so the page's edge stays under the finger that pulled it out.
    this.write(clampFraction(dx / this.travel));
  };

  readonly pointerUp = (event: EdgeBackPointerInput): void => {
    if (event.pointerId !== this.activePointer) return;
    if (this.phase !== "dragging") {
      this.reset();
      return;
    }
    this.pushSample(event.clientX);
    const back = this.shouldGoBack();
    this.reset();
    this.settle(back);
  };

  /**
   * `pointercancel` and a lost capture both mean the gesture was taken away
   * mid-flight. Settling by position — never by velocity, which is
   * meaningless once the system has intervened — is what keeps the page off
   * half-dragged.
   */
  readonly pointerCancel = (event: EdgeBackPointerInput): void => {
    if (event.pointerId !== this.activePointer) return;
    const wasDragging = this.phase === "dragging";
    const fraction = this.fractionRef.current;
    this.reset();
    if (wasDragging) this.settle(fraction >= EDGE_BACK_POSITION_THRESHOLD);
  };

  /**
   * External abort, for the wiring's effect cleanup: the page is unmounting,
   * or the gesture was disabled mid-flight (a modal opened under the finger).
   * Unlike `pointerCancel` this settles nothing — a gesture the UI no longer
   * owns must not navigate — it only rewinds to rest, so a later re-enable
   * that paints `getState()` starts from an untouched page instead of
   * wherever the abandoned drag left the fraction. No frame is emitted: the
   * only caller runs inside a cleanup that has already dropped its own
   * subscription and resets the element's styles itself.
   */
  readonly cancel = (): void => {
    this.reset();
    this.dragging = false;
    this.fractionRef.current = 0;
  };

  /**
   * Velocity beats position. Without it, a fast flick from the edge that only
   * travelled 30% of the way falls back to cancelled, which reads as the
   * gesture ignoring the flick rather than as a threshold being missed.
   */
  private shouldGoBack(): boolean {
    const velocity = this.recentVelocity();
    // Only a rightward flick counts. A fast retreat toward the edge is the
    // finger changing its mind, and falling through to the position check
    // correctly reads that as "still short of halfway, cancel" rather than
    // inventing a second way to trigger the same outcome as a slow drag.
    if (velocity !== null && velocity >= EDGE_BACK_FLICK_VELOCITY_PX_PER_MS) return true;
    return this.fractionRef.current >= EDGE_BACK_POSITION_THRESHOLD;
  }

  private recentVelocity(): number | null {
    const last = this.samples[this.samples.length - 1];
    if (!last || this.samples.length < 2) return null;
    const cutoff = last.t - EDGE_BACK_VELOCITY_WINDOW_MS;
    let first = this.samples[this.samples.length - 2];
    for (let i = this.samples.length - 2; i >= 0; i--) {
      if (this.samples[i].t < cutoff) break;
      first = this.samples[i];
    }
    const elapsed = last.t - first.t;
    if (elapsed <= 0) return null;
    return (last.x - first.x) / elapsed;
  }

  private pushSample(x: number) {
    const t = this.clock();
    this.samples.push({ x, t });
    // Keep one sample beyond the window, so a gesture that pauses and then
    // releases still has two points to divide.
    while (this.samples.length > 2 && this.samples[1].t < t - EDGE_BACK_VELOCITY_WINDOW_MS) {
      this.samples.shift();
    }
  }

  private write(fraction: number) {
    if (fraction === this.fractionRef.current) return;
    this.fractionRef.current = fraction;
    this.emit();
  }

  private settle(back: boolean) {
    this.dragging = false;
    this.fractionRef.current = back ? 1 : 0;
    this.emit();
    const outcome: EdgeBackOutcome = back ? "back" : "cancelled";
    for (const listener of this.settledListeners) listener(outcome);
  }

  private reset() {
    this.phase = "idle";
    this.activePointer = null;
    this.samples = [];
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.frameListeners) listener(state);
  }
}
