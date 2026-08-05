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
const PANEL_DEFAULT_WIDTH = 525;
/**
 * The notes rail is a margin, not a workspace: it holds one column of cards
 * beside the text and every pixel it takes comes off the page. The AI panel is
 * the opposite — it holds a conversation, and 380 would cramp it. So the width
 * is per panel rather than one number shared by all four; dragging one no longer
 * resizes the others behind it either, which was never intended.
 */
export type ResizableSidePanel = "ai" | "bookmarks" | "vocab" | "notes";

const PANEL_DEFAULT_WIDTHS: Partial<Record<ResizableSidePanel, number>> = { notes: 380 };

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
