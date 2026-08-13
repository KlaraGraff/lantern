import { useEffect, useRef, type RefObject } from "react";
import { selectedRange } from "../components/reader-interaction";
import { useCoarsePointer } from "./useCoarsePointer";

/**
 * Everything the selection-menu opener reads off the event it is handed: the
 * element the gesture belongs to, which is what scopes the selection to this
 * surface. Declared structurally so the touch path can call the same handler
 * without manufacturing a `MouseEvent` it never received — a selection-handle
 * drag produces no mouse event at all, and a faked one would only mislead the
 * next person who reads that handler. A real `React.MouseEvent` satisfies this
 * shape, so the mouse path keeps passing its own event unchanged.
 */
export interface PanelSelectionSource {
  currentTarget: HTMLElement;
}

/**
 * Marks the surfaces whose long press this hook answers, for the
 * `-webkit-touch-callout` rule in `index.css`. Applied from here rather than
 * written into each component's JSX so the suppression cannot outlive the menu
 * that replaces it: an element only loses the OS callout while this hook is
 * actually watching it.
 */
const SELECTION_SURFACE_ATTRIBUTE = "data-panel-selection";

/**
 * How long the selection has to hold still before the menu is asked for.
 *
 * WebKit emits `selectionchange` at frame cadence while a handle moves, so this
 * only has to outlast the gap between two frames of one drag. Every extra
 * millisecond is added to the wait the reader feels after lifting the finger —
 * on top of the opener's own debounce, which is the longer of the two.
 */
const SELECTION_SETTLE_MS = 120;

/**
 * Opens Lantern's selection menu for text selected with a finger.
 *
 * The prose surfaces outside the book — an AI answer, a learning card — wired
 * this gesture to `onMouseUp`, which a phone never sends: WKWebView synthesises
 * mouse events after a *tap*, and a selection made by long-pressing and then
 * dragging the handles produces none at all. So on touch the menu simply never
 * appeared and the reader got the OS callout instead.
 *
 * The answer is the one the book's own text already uses
 * (`useReaderInteractions.ts`): watch `selectionchange`, stand down while a
 * pointer is still down, and act once the selection stops moving. Two hazards
 * come with it, and both are handled below — a change that arrives mid-drag
 * must not open a menu under the finger, and a gesture that ends without any
 * further change (long-press a word, lift) must still be answered.
 *
 * Coarse pointers only. Not because a mouse cannot drag-select — this listener
 * would serve it fine — but because the desktop path is already correct, and
 * leaving both installed would have one gesture arrive twice.
 */
export function usePanelTextSelection<T extends HTMLElement = HTMLElement>(
  onSelectText?: (source: PanelSelectionSource) => void,
  /**
   * The surface's own ref, where it already has one — a scroll container is
   * usually already held for scrolling. Adopting it keeps one ref on the
   * element instead of asking callers to fan a callback ref out to two.
   */
  surfaceRef?: RefObject<T | null>,
) {
  const ownRef = useRef<T>(null);
  const rootRef = surfaceRef ?? ownRef;
  const coarsePointer = useCoarsePointer();
  // Re-read on every fire rather than closed over: the listeners below are
  // installed once, and the callers pass a fresh arrow on every render.
  const callbackRef = useRef(onSelectText);
  useEffect(() => {
    callbackRef.current = onSelectText;
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!coarsePointer || !root) return;
    root.setAttribute(SELECTION_SURFACE_ATTRIBUTE, "");

    let settleTimer: number | null = null;
    /**
     * How many pointers are down. A count rather than a flag because a second
     * finger landing mid-selection must not read as the first one lifting.
     */
    let pointersDown = 0;
    /**
     * A `selectionchange` arrived while a pointer was down and was skipped.
     * Without this, the commonest gesture on a phone would be lost entirely:
     * long-press a word, lift, and the only change the selection ever made was
     * the one that happened under the finger. This is the same job the reader's
     * `finalizePointerSelection` does when it re-derives the selection on
     * pointerup.
     */
    let changedWhileDown = false;

    const cancelSettle = () => {
      if (settleTimer === null) return;
      window.clearTimeout(settleTimer);
      settleTimer = null;
    };

    const settle = () => {
      settleTimer = null;
      const surface = rootRef.current;
      if (!surface) return;
      const range = selectedRange(document);
      // Selections elsewhere in this document are somebody else's: a text book
      // renders its pages into the very same document, and its own handling
      // rewrites the selection there while this listener is live. An emptied
      // selection lands here too — a tap that dismisses one is a
      // `selectionchange` like any other — and is likewise not a menu.
      if (!range || !surface.contains(range.commonAncestorContainer)) return;
      callbackRef.current?.({ currentTarget: surface });
    };

    const scheduleSettle = () => {
      cancelSettle();
      settleTimer = window.setTimeout(settle, SELECTION_SETTLE_MS);
    };

    const handleSelectionChange = () => {
      cancelSettle();
      if (pointersDown > 0) {
        changedWhileDown = true;
        return;
      }
      // iOS hands the gesture to its own selection UI partway through a long
      // press, and the `pointercancel` that comes with it leaves the count at
      // zero while the finger is still dragging a handle. The debounce is what
      // actually covers the rest of that drag: each frame's change pushes the
      // menu back, so it opens only once the handles have stopped.
      scheduleSettle();
    };

    const handlePointerDown = () => {
      pointersDown += 1;
      cancelSettle();
    };

    const handlePointerEnd = () => {
      pointersDown = Math.max(0, pointersDown - 1);
      if (pointersDown > 0 || !changedWhileDown) return;
      changedWhileDown = false;
      scheduleSettle();
    };

    const handleBlur = () => {
      // The app went away mid-gesture; the pointers it was counting are never
      // coming back up, and a menu is not what the reader is looking at now.
      pointersDown = 0;
      changedWhileDown = false;
      cancelSettle();
    };

    // Capture phase, so a component that stops a pointer event from bubbling —
    // the card's own drag handle, for one — cannot leave the count stuck above
    // zero and the whole gesture unanswered from then on.
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerEnd, true);
    document.addEventListener("pointercancel", handlePointerEnd, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      cancelSettle();
      root.removeAttribute(SELECTION_SURFACE_ATTRIBUTE);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerEnd, true);
      document.removeEventListener("pointercancel", handlePointerEnd, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [coarsePointer, rootRef]);

  return {
    rootRef,
    /**
     * Spread onto the same element the ref goes on. It carries the mouse path,
     * dropped exactly where the listener above takes over, so the two can never
     * both answer one gesture.
     */
    selectionProps: { onMouseUp: coarsePointer ? undefined : onSelectText },
  };
}
