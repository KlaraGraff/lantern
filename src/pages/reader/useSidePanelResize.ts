import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;
/**
 * Panel defaults are set by line length, not by pixels.
 *
 * A panel and the book column compete for the same screen. What decides the
 * split is how many characters land on one line inside each — the typographic
 * "measure". Bringhurst's comfortable band is 45–75 characters; WCAG 1.4.8 caps
 * a line at 80 characters, or 40 for CJK, because a Han character is about
 * twice as wide. The AI answers here are mixed Chinese and English, so the CJK
 * count is the binding one.
 *
 * 66 characters is the optimum for a *primary* reading surface. This is not
 * one — the book is. So the panel takes the lower half of the band and the
 * width it gives up goes back to the page. Subtracting the list padding, the
 * bubble border and the bubble padding (52px in total) from 440 leaves 388px of
 * 14px text: ~53 Latin characters, ~28 Han. Both mid-band, both clear of the
 * WCAG ceiling. The old 525 sat at 65 / 34 — inside the band, but spending 36%
 * of a 1440px window on the sidebar to get there.
 *
 * Reasoning in full, with the competitor survey: `docs/guide/side-panel-width.md`.
 */
const PANEL_DEFAULT_WIDTH = 440;
/**
 * Width is per panel, not per tab. The AI panel holds a conversation and the
 * traces panel holds lists, so they want different widths and dragging one
 * must not resize the other behind it.
 *
 * Inside the traces panel it is deliberately ONE width for all four tabs. The
 * notes tab used to have its own key and its own 380px default, so switching
 * to it snapped the panel from 525 to 380 and reflowed the page under it — a
 * visible jolt on a plain tab change. Panel geometry belongs to the panel; the
 * active tab does not get a say in it.
 */
export type ResizableSidePanel = "ai" | "traces";

// Lists, not prose — no measure to satisfy, only "a word, its gloss and its
// metadata fit on one row". Scaled down by the same proportion as the AI panel.
const PANEL_DEFAULT_WIDTHS: Partial<Record<ResizableSidePanel, number>> = { traces: 400 };

interface ShadowHost {
  shadowRoot: ShadowRoot | null;
}

export function useSidePanelResize<T extends ShadowHost>(
  viewRef: RefObject<T | null>,
  viewerRef: RefObject<HTMLElement | null>,
  panel: ResizableSidePanel | null,
) {
  const [widths, setWidths] = useState<Partial<Record<ResizableSidePanel, number>>>({});
  // Nothing is open, so nothing is measured — the container is hidden. Any slot
  // will do; "ai" avoids widening the key type for a width no one can see.
  const panelKey = panel ?? "ai";
  const panelWidth = widths[panelKey]
    ?? PANEL_DEFAULT_WIDTHS[panelKey]
    ?? PANEL_DEFAULT_WIDTH;
  const panelWidthRef = useRef(panelWidth);
  const panelKeyRef = useRef(panelKey);
  const panelRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    panelWidthRef.current = panelWidth;
    panelKeyRef.current = panelKey;
  }, [panelKey, panelWidth]);

  const handlePanelResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isDraggingRef.current = true;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = panelWidthRef.current;
    // The drag belongs to the panel it started on, whatever is open by the time
    // it ends — otherwise a panel switch mid-drag would write the new width onto
    // the wrong panel.
    const draggedPanel = panelKeyRef.current;
    const setPanelWidth = (width: number) => {
      setWidths((current) => ({ ...current, [draggedPanel]: width }));
    };
    let rafId = 0;
    let latestWidth = startWidth;
    let finished = false;

    const renderer = viewRef.current?.shadowRoot
      ?.querySelector("foliate-paginator, foliate-fxl, foliate-pdf-scroll");
    renderer?.setAttribute("resize-dragging", "");

    // Freeze the reader viewport at its current pixel width for the duration of
    // the drag. Reflow is suppressed while dragging, so if we let the viewer
    // shrink live with the flex layout, Foliate's frozen columnization no longer
    // matches the container and the current page renders horizontally clipped
    // until release. Pinning the width keeps the columnization valid; the
    // growing panel simply covers the viewer's right edge (main is
    // overflow-hidden). Restored in cleanup, just before the drag-end reflow.
    const viewer = viewerRef.current;
    if (viewer) viewer.style.width = `${viewer.clientWidth}px`;

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
      // Release the frozen width first so the viewer flexes to its final size,
      // then drop `resize-dragging` — the drag-end reflow that fires on removal
      // reads the correct final width in one shot.
      if (viewer) viewer.style.width = "";
      renderer?.removeAttribute("resize-dragging");
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
  }, [viewRef, viewerRef]);

  return { handlePanelResizePointerDown, panelRef, panelWidth };
}
