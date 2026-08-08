import { flip, offset, shift } from "@floating-ui/dom";
import type { Middleware, Placement } from "@floating-ui/dom";

/**
 * Where a click-anchored popover goes, as data.
 *
 * Split out from `use-popover-position` so it can be tested: these three
 * middleware are what decide whether the reader sees the popover clipped at
 * the edge of the window, and `useFloating` cannot be called outside React.
 * `@floating-ui/dom`'s middleware are the platform-agnostic ones re-exported
 * from core, so this module imports no DOM and no React.
 */

/** Viewport margin the popover keeps on every side. */
export const VIEWPORT_PADDING = 16;

/** Gap left above the anchor point when the popover opens upward. */
export const FLIP_GAP = 8;

/** Down and to the right of the click, which is where these have always opened. */
export const POPOVER_PLACEMENT: Placement = "bottom-start";

/**
 * The middleware chain, in order: nudge off the anchor, flip to the other side
 * if this one overflows, then slide along the edge to stay in view.
 *
 * The offset is asymmetric — flush against the point downward, `FLIP_GAP`
 * above it upward. That asymmetry looks accidental in the hand-rolled code it
 * replaces, but it is what every one of these popovers looks like today, and
 * swapping the positioning engine is not the place to change how they land.
 *
 * `crossAxis` on `shift` is what keeps a popover taller than the space above
 * *and* below from running off the top: it slides down into view instead of
 * being left with a negative `top`.
 */
export function popoverMiddleware(): Middleware[] {
  return [
    offset(({ placement }) => (placement.startsWith("top") ? FLIP_GAP : 0)),
    // `crossAxis: false` keeps the alignment fixed. Left on, a click near the
    // right edge would flip `bottom-start` to `bottom-end` and the popover
    // would open leftward from the word instead of rightward — better
    // anchoring, arguably, but a visible change in where the popover appears,
    // and swapping the positioning engine is not the place to make it.
    flip({ padding: VIEWPORT_PADDING, crossAxis: false }),
    shift({ padding: VIEWPORT_PADDING, crossAxis: true }),
  ];
}
