/**
 * The motion tokens, for the animations JavaScript has to run itself.
 *
 * Most motion in the app is CSS and reads `--motion-*` and `--ease-*-soft`
 * directly (see the Motion block in `index.css`). A few animations cannot be:
 * anything whose start and end heights are both `auto` has to be measured
 * across a commit and handed to the Web Animations API, and that API wants
 * numbers and strings, not custom properties.
 *
 * Those call sites read the tokens back out of the stylesheet rather than
 * repeating their values, so the durations stay defined in exactly one place.
 * A hardcoded `220` here would silently stop matching the CSS the first time
 * someone retunes `--motion-base`, and the whole reason for a token layer is
 * that retuning is meant to be one edit.
 */

/** Durations, keyed by the half of the custom property name that varies. */
export type MotionDuration = "instant" | "fast" | "base";

/** Curves, same convention. */
export type MotionEasing = "out-soft" | "in-out-soft";

/**
 * What the tokens are worth if the stylesheet cannot be consulted.
 *
 * Not dead code: `getComputedStyle` returns an empty string for a custom
 * property on an element that is not in a rendered document, which is the
 * state every one of these components is in under a unit test or during the
 * first tick of a hot reload. Falling back to 0 there would turn a graceful
 * animation into a jump; falling back to the real numbers keeps the behaviour
 * identical and merely un-retunable, which is the harmless failure.
 */
const FALLBACK_DURATION: Record<MotionDuration, number> = {
  instant: 90,
  fast: 140,
  base: 220,
};

const FALLBACK_EASING: Record<MotionEasing, string> = {
  "out-soft": "cubic-bezier(0.16, 1, 0.3, 1)",
  "in-out-soft": "cubic-bezier(0.4, 0, 0.2, 1)",
};

function readToken(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A `--motion-*` token in milliseconds, ready for `Element.animate`. */
export function motionDuration(token: MotionDuration): number {
  const raw = readToken(`--motion-${token}`);
  // CSS time values are `ms` or `s`, and the `s` suffix is a suffix of `ms`,
  // so the millisecond test has to come first.
  const milliseconds = raw.endsWith("ms")
    ? Number.parseFloat(raw)
    : raw.endsWith("s")
      ? Number.parseFloat(raw) * 1000
      : Number.NaN;
  return Number.isFinite(milliseconds) ? milliseconds : FALLBACK_DURATION[token];
}

/** An `--ease-*-soft` token as a timing-function string. */
export function motionEasing(token: MotionEasing): string {
  return readToken(`--ease-${token}`) || FALLBACK_EASING[token];
}

/**
 * Point a scaling element's growth at the thing that opened it.
 *
 * `.motion-pop` scales from 96%, and a default centre origin makes every
 * popover swell out of its own middle no matter where the click was. Anchoring
 * the origin at the click instead is what turns the animation from decoration
 * into a reply: the menu unfolds from the word, the toolbar from the
 * highlight.
 *
 * The anchor is usually a corner of the element, but not always — a popover
 * shifted away from a viewport edge no longer starts at the point that opened
 * it, so the point is clamped into the box rather than assumed to be on it.
 * An origin outside the box would swing the element in from off to one side.
 *
 * Both arguments are in viewport coordinates, and the element's own size comes
 * from `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect()`:
 * the rect is measured *after* transforms, so calling this while the entry
 * animation is running would size the origin against a box 4% smaller than the
 * one that settles a frame later.
 */
export function anchorTransformOrigin(
  element: HTMLElement,
  anchor: { x: number; y: number },
  box: { left: number; top: number },
): void {
  const originX = Math.min(Math.max(anchor.x, box.left), box.left + element.offsetWidth) - box.left;
  const originY = Math.min(Math.max(anchor.y, box.top), box.top + element.offsetHeight) - box.top;
  element.style.transformOrigin = `${originX}px ${originY}px`;
}
