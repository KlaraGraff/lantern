import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

/**
 * Gesture constants for the narrow-screen Home drawer.
 *
 * These are readest's tuned values, taken through `docs/roadmap/readest-comparison.md` §5
 * and recorded in the table in `docs/impls/mobile-home-drawer.md` — they were not invented
 * here. They were tuned against each other, so moving one alone changes the feel more than
 * the number suggests.
 */
export const DRAWER_EDGE_ZONE_PX = 20;
export const DRAWER_VERTICAL_LOCK_PX = 8;
export const DRAWER_DIRECTION_DOMINANCE = 1.5;
export const DRAWER_POSITION_THRESHOLD = 0.5;
export const DRAWER_FLICK_VELOCITY_PX_PER_MS = 0.5;
/** Only for after the finger leaves; there is no transition during a drag. */
export const DRAWER_SETTLE_MS = 200;

/**
 * The table gives a dominance ratio but no minimum horizontal travel, and one
 * jittery pixel already beats a ratio when vertical movement is zero. The
 * vertical lock distance doubles as horizontal slop so a tap or a hesitant
 * press never nudges the drawer.
 */
export const DRAWER_HORIZONTAL_CLAIM_PX = DRAWER_VERTICAL_LOCK_PX;

/**
 * Release velocity is measured over the last samples inside this window, not
 * across the whole gesture. A drag that crawls for a second and then flicks is
 * a flick; averaging from first touch to release would read it as a crawl.
 */
export const DRAWER_VELOCITY_WINDOW_MS = 100;

/** Everything the gesture needs from a pointer event, and nothing more. */
export interface DrawerPointerInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface DrawerGestureState {
  /** 0 = closed, 1 = fully open. Clamped. */
  fraction: number;
  /** The settled target. During a drag this still reports where it settled last. */
  open: boolean;
  /** True while the finger owns the position — the component's transition goes on only when false. */
  dragging: boolean;
}

export interface DrawerGestureConfig {
  /** Drawer travel in px, read once per drag. The hook never measures the DOM itself. */
  width: () => number;
  /** Injectable clock, so tests do not need real timers. */
  now?: () => number;
  initialOpen?: boolean;
}

type Phase = "idle" | "candidate" | "dragging" | "rejected";

const clampFraction = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * The decision half of the drawer: pointer samples in, an open fraction out.
 * It never touches the DOM and never renders, which is what lets it be tested
 * without a browser.
 */
export class DrawerGestureController {
  /** Live position. Readable at any moment without a re-render. */
  readonly fractionRef: { current: number };

  private width: () => number;
  private clock: () => number;
  private openState: boolean;
  private dragging = false;

  private phase: Phase = "idle";
  private activePointer: number | null = null;
  private startX = 0;
  private startY = 0;
  private baseFraction = 0;
  private travel = 1;
  private samples: { x: number; t: number }[] = [];

  private frameListeners = new Set<(state: DrawerGestureState) => void>();
  private settledListeners = new Set<() => void>();

  constructor(config: DrawerGestureConfig) {
    this.width = config.width;
    this.clock = config.now ?? (() => performance.now());
    this.openState = config.initialOpen ?? false;
    this.fractionRef = { current: this.openState ? 1 : 0 };
  }

  /** Lets a re-rendered component hand over fresh closures without a new controller. */
  configure(config: Pick<DrawerGestureConfig, "width" | "now">) {
    this.width = config.width;
    if (config.now) this.clock = config.now;
  }

  readonly getState = (): DrawerGestureState => ({
    fraction: this.fractionRef.current,
    open: this.openState,
    dragging: this.dragging,
  });

  readonly isOpen = (): boolean => this.openState;

  /** Fires on every position change, including each pointermove. Not for React state. */
  readonly subscribe = (listener: (state: DrawerGestureState) => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  /** Fires only when the settled open/closed state actually flips — at most once per gesture. */
  readonly subscribeSettled = (listener: () => void): (() => void) => {
    this.settledListeners.add(listener);
    return () => {
      this.settledListeners.delete(listener);
    };
  };

  /** For the hamburger button, the scrim, and Esc. Abandons any drag in flight. */
  readonly setOpen = (open: boolean): void => {
    this.reset();
    this.settle(open);
  };

  /**
   * Returns true when the pointer is worth following. False means the gesture is
   * none of the drawer's business — do not capture it and do not preventDefault,
   * or the shelf stops scrolling. A true here is still not a claim: the drawer
   * only starts moving once `pointerMove` clears the direction lock.
   */
  readonly pointerDown = (event: DrawerPointerInput): boolean => {
    if (this.activePointer !== null) return false;
    // Opening is edge-only, because the middle of the shelf is spoken for by
    // future horizontal gestures. Closing takes any start point on the drawer.
    if (!this.openState && event.clientX >= DRAWER_EDGE_ZONE_PX) return false;

    this.phase = "candidate";
    this.activePointer = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.baseFraction = this.openState ? 1 : 0;
    this.samples = [{ x: event.clientX, t: this.clock() }];
    return true;
  };

  readonly pointerMove = (event: DrawerPointerInput): void => {
    if (event.pointerId !== this.activePointer || this.phase === "rejected") return;
    this.pushSample(event.clientX);

    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;

    if (this.phase === "candidate") {
      // The direction lock is one-way and permanent. Someone scrolling the
      // shelf drifts sideways all the time; if the drawer could still claim
      // the gesture afterwards, a flick down the page would open it.
      if (Math.abs(dy) > DRAWER_VERTICAL_LOCK_PX) {
        this.phase = "rejected";
        return;
      }
      if (Math.abs(dx) < DRAWER_HORIZONTAL_CLAIM_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * DRAWER_DIRECTION_DOMINANCE) return;
      this.phase = "dragging";
      this.dragging = true;
      this.travel = Math.max(1, this.width());
    }

    // Measured from the original touch point, not from where the claim landed,
    // so the drawer's edge stays under the finger that pulled it out.
    this.write(clampFraction(this.baseFraction + dx / this.travel));
  };

  readonly pointerUp = (event: DrawerPointerInput): void => {
    if (event.pointerId !== this.activePointer) return;
    if (this.phase !== "dragging") {
      this.reset();
      return;
    }
    this.pushSample(event.clientX);
    const target = this.settleTarget();
    this.reset();
    this.settle(target);
  };

  /**
   * `pointercancel` and a lost capture both mean the gesture was taken away
   * mid-flight. Settling by position — never by velocity, which is meaningless
   * once the system has intervened — is what keeps the drawer off half-open.
   */
  readonly pointerCancel = (event: DrawerPointerInput): void => {
    if (event.pointerId !== this.activePointer) return;
    const wasDragging = this.phase === "dragging";
    const fraction = this.fractionRef.current;
    this.reset();
    if (wasDragging) this.settle(fraction >= DRAWER_POSITION_THRESHOLD);
  };

  /**
   * Velocity beats position. Without it, a fast flick from the edge that only
   * travelled 30% of the way falls back closed, which reads as the drawer
   * ignoring the gesture rather than as a threshold being missed.
   */
  private settleTarget(): boolean {
    const velocity = this.recentVelocity();
    if (velocity !== null && Math.abs(velocity) >= DRAWER_FLICK_VELOCITY_PX_PER_MS) return velocity > 0;
    return this.fractionRef.current >= DRAWER_POSITION_THRESHOLD;
  }

  private recentVelocity(): number | null {
    const last = this.samples[this.samples.length - 1];
    if (!last || this.samples.length < 2) return null;
    const cutoff = last.t - DRAWER_VELOCITY_WINDOW_MS;
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
    while (this.samples.length > 2 && this.samples[1].t < t - DRAWER_VELOCITY_WINDOW_MS) {
      this.samples.shift();
    }
  }

  private write(fraction: number) {
    if (fraction === this.fractionRef.current) return;
    this.fractionRef.current = fraction;
    this.emit();
  }

  private settle(open: boolean) {
    const flipped = open !== this.openState;
    this.openState = open;
    this.dragging = false;
    this.fractionRef.current = open ? 1 : 0;
    this.emit();
    if (flipped) for (const listener of this.settledListeners) listener();
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

/**
 * Owns the drawer's open/closed decision and its live position.
 *
 * Only `open` is React state; it changes at most once per gesture. The position
 * during a drag arrives through `fractionRef` and `subscribe`, which a
 * re-render per pointermove would otherwise pay for in dropped frames on a
 * phone — write the transform and the scrim opacity from the subscription.
 */
export function useDrawerGesture(config: DrawerGestureConfig) {
  const [controller] = useState(() => new DrawerGestureController(config));
  useEffect(() => {
    controller.configure(config);
  });

  const open = useSyncExternalStore(controller.subscribeSettled, controller.isOpen, controller.isOpen);

  return useMemo(
    () => ({
      open,
      fractionRef: controller.fractionRef,
      subscribe: controller.subscribe,
      getState: controller.getState,
      setOpen: controller.setOpen,
      /** Returns false when the drawer wants nothing to do with this pointer — leave it alone. */
      onPointerDown: controller.pointerDown,
      onPointerMove: controller.pointerMove,
      onPointerUp: controller.pointerUp,
      onPointerCancel: controller.pointerCancel,
      onLostPointerCapture: controller.pointerCancel,
    }),
    [controller, open],
  );
}
