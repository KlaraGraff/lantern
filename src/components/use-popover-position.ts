import { useCallback, useMemo } from "react";
import { autoUpdate, useFloating } from "@floating-ui/react-dom";
import { POPOVER_PLACEMENT, popoverMiddleware } from "./popover-placement";

/**
 * Where a click-anchored popover goes.
 *
 * `ExplainPopover`, `TranslationPopover` and `FootnotePopover` each carried an
 * identical copy of the same twenty lines: read `getBoundingClientRect`, clamp
 * left into the viewport, and if the bottom overflows, move up by the popover's
 * own height. Twice that arithmetic had to be fixed after shipping — `2a0b907`
 * when streamed content grew the box past the edge it had already been clamped
 * against, and `9c5523b` when rendering markdown changed the height the same
 * way. Both are the same bug: the position was computed against a size that
 * then changed.
 *
 * That is the bug class `autoUpdate` removes. It re-runs placement whenever the
 * floating element resizes, the window resizes, or an ancestor scrolls — so
 * there is no moment where the stored position describes a box that no longer
 * exists. The hand-rolled version only watched the popover's own resize, which
 * is why a window resize left it clipped.
 */

export interface PopoverPosition {
  /** Attach to the popover element. Stable across renders. */
  ref: (node: HTMLElement | null) => void;
  /**
   * Whether `node` is outside the popover — the check behind each popover's
   * dismiss-on-outside-click. A callback rather than the ref itself, so the
   * popover never touches a `.current` during render.
   *
   * `false` while the popover is unmounted, which keeps the original
   * behaviour: a click that arrives before the element exists dismisses
   * nothing.
   */
  isOutside: (node: Node | null) => boolean;
  /** Spread onto the popover's `style`. Already includes `position: fixed`. */
  style: React.CSSProperties;
}

/**
 * Anchor a popover at a viewport point.
 *
 * The anchor is a point rather than an element — these popovers open at a click
 * inside the foliate iframe, where there is no DOM node on this side to hand
 * over — so the reference is a zero-size virtual element at `(x, y)`.
 *
 * Placement itself lives in `popover-placement`, which has tests.
 */
export function usePopoverPosition(x: number, y: number): PopoverPosition {
  const reference = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }),
    [x, y],
  );

  const { refs, floatingStyles, isPositioned } = useFloating({
    elements: { reference },
    placement: POPOVER_PLACEMENT,
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: popoverMiddleware(),
  });

  const isOutside = useCallback(
    (node: Node | null) => {
      const element = refs.floating.current;
      return Boolean(element && node && !element.contains(node));
    },
    [refs.floating],
  );

  return {
    ref: refs.setFloating,
    isOutside,
    // The first placement is measured, so it lands one frame after mount.
    // Without this the popover paints once at the top-left corner first.
    style: { ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" },
  };
}
