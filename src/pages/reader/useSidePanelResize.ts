import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { freezeReader, type ShadowHost } from "./reader-freeze";
import { CARD_INSET, RIGHT_CARD_WIDTH } from "./reader-sides";

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;
/**
 * The right card's width, set by the 「浮笺」 design (§11 of the redesign doc):
 * 380px, draggable 320–560.
 *
 * Narrower than the 440 that `docs/guide/side-panel-width.md` derives from line
 * length, on purpose: that number was for a column welded beside the page,
 * paid for by the book on every visit. The card floats over the margin when it
 * can, and when it cannot it takes its room from the page, so the design spends
 * less of it. 380 leaves 328px of 14px text after the bubble padding: ~45 Latin
 * characters, ~23 Han, the bottom of the comfortable band rather than its
 * middle. A reader who wants more drags it.
 *
 * One width per side, not per view. The conversation and the traces used to
 * keep 440 and 400, so switching between them reflowed the page; a card's
 * geometry belongs to the side, and switching what it shows never moves it.
 */
const PANEL_DEFAULT_WIDTH = RIGHT_CARD_WIDTH;

/** An inline override of the slot's stylesheet transition; "" hands it back. */
function setSlotTransition(slot: HTMLElement, value: string) {
  slot.style.transition = value;
}

/**
 * `resizable` is false on a viewport too narrow to split, where the panel
 * covers the reading area instead of docking beside it. There is nothing left
 * to drag then, and a 6px drag bar under a finger is not a small control but a
 * trap — so the reader stops rendering the bar, and this stops answering.
 *
 * Both, deliberately. Not rendering the bar is what actually prevents the drag,
 * since every window listener this hook installs is installed from inside
 * `handlePanelResizePointerDown` and nothing else calls it. The guard below is
 * the second lock: a live `pointerdown` handler sitting under an element that
 * was merely hidden with CSS is worse than a visible one, and this makes that
 * mistake unreachable rather than merely absent.
 *
 * `panelWidth` comes back undefined in that mode, so the reader has no inline
 * width to write and the stylesheet's breakpoint owns the panel's geometry —
 * an inline `width` would beat any class it was given.
 */
export function useSidePanelResize<T extends ShadowHost>(
  viewRef: RefObject<T | null>,
  viewerRef: RefObject<HTMLElement | null>,
  resizable: boolean,
  slotRef?: RefObject<HTMLElement | null>,
) {
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const panelWidthRef = useRef(panelWidth);
  const panelRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    panelWidthRef.current = panelWidth;
  }, [panelWidth]);

  const handlePanelResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    if (event.button !== 0) return;
    event.preventDefault();
    isDraggingRef.current = true;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = panelWidthRef.current;
    // A pinned card has a slot beside the page as wide as the card and its
    // insets; it follows the card so the drag ends with nothing left to move.
    const slot = slotRef?.current ?? null;
    const slotFollows = slot !== null && slot.clientWidth > 0;
    // The slot eases its width for pin and unpin. Under a drag that easing is
    // a lag: the page edge trails the pointer and keeps sliding after the
    // button is up. A drag is direct manipulation — it lands on the frame the
    // pointer lets go — so the slot drops its transition for the duration.
    if (slotFollows) setSlotTransition(slot, "none");
    let rafId = 0;
    let latestWidth = startWidth;
    let finished = false;

    // Held at its current width for the drag; see `freezeReader`. Released in
    // cleanup, just before the drag-end reflow.
    const release = freezeReader(viewRef.current, viewerRef.current);

    const widthFromClientX = (clientX: number) => {
      const delta = startX - clientX;
      return Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + delta),
      );
    };

    const schedulePanelWidth = (width: number) => {
      latestWidth = width;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        if (panelRef.current) {
          panelRef.current.style.width = `${latestWidth}px`;
        }
        if (slotFollows) slot.style.width = `${latestWidth + CARD_INSET * 2}px`;
        rafId = 0;
      });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
      handle.removeEventListener("lostpointercapture", handleLostPointerCapture);
      try {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch { /* pointer capture can already be gone */ }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (slotFollows) {
        // Commit the final width with the transition still off, then hand the
        // stylesheet its easing back; without the forced style read the two
        // writes batch and the slot animates to where it already is.
        void slot.offsetWidth;
        setSlotTransition(slot, "");
      }
      release();
    };

    const finishDrag = (clientX?: number) => {
      if (finished) return;
      finished = true;
      isDraggingRef.current = false;
      if (typeof clientX === "number") {
        latestWidth = widthFromClientX(clientX);
      }
      if (rafId) cancelAnimationFrame(rafId);
      if (panelRef.current) {
        panelRef.current.style.width = `${latestWidth}px`;
      }
      if (slotFollows) slot.style.width = `${latestWidth + CARD_INSET * 2}px`;
      cleanup();
      setPanelWidth(latestWidth);
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      if (!isDraggingRef.current) return;
      schedulePanelWidth(widthFromClientX(pointerEvent.clientX));
    }

    function handlePointerUp(pointerEvent: PointerEvent) {
      finishDrag(pointerEvent.clientX);
    }

    function handlePointerCancel() {
      finishDrag();
    }

    function handleWindowBlur() {
      finishDrag();
    }

    function handleLostPointerCapture() {
      finishDrag();
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      handle.setPointerCapture(pointerId);
    } catch { /* pointer capture is best-effort */ }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);
    handle.addEventListener("lostpointercapture", handleLostPointerCapture);
  }, [resizable, slotRef, viewRef, viewerRef]);

  return {
    handlePanelResizePointerDown,
    panelRef,
    panelWidth: resizable ? panelWidth : undefined,
  };
}
