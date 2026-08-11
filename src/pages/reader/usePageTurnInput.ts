import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { ReaderSettingsState } from "../../components/ReaderSettings";
import {
  keyboardEventMatchesBinding,
  mouseEventMatchesBinding,
} from "../../components/reader-bindings";
import { appZoomCommandFor } from "../../services/app-zoom";
import { createKeyboardPageTurnRepeater } from "../../components/keyboard-page-turn";
import type { KeyboardPageTurnRepeater } from "../../components/keyboard-page-turn";
import { createPageTurnDispatcher } from "../../components/page-turn-dispatcher";
import type { PageTurnDispatcher } from "../../components/page-turn-dispatcher";
import { createWheelPageTurnHandler } from "../../components/wheel-page-turn";
import type { WheelPageTurnHandler } from "../../components/wheel-page-turn";

type PageDirection = "previous" | "next";

interface PageTurnInputOptions {
  bookFormat?: string;
  settingsRef: MutableRefObject<ReaderSettingsState>;
  readerViewportRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  overlayOpen: boolean;
  sidePanelOpen: boolean;
  turnPage(direction: PageDirection): void | Promise<void>;
  onPdfZoom(delta: number): void;
  onPdfZoomFit(): void;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export function usePageTurnInput({
  bookFormat,
  settingsRef,
  readerViewportRef,
  panelRef,
  overlayOpen,
  sidePanelOpen,
  turnPage,
  onPdfZoom,
  onPdfZoomFit,
}: PageTurnInputOptions) {
  const suppressContextMenuUntilRef = useRef(0);
  const keyboardBlockedRef = useRef(false);
  const overlayOpenRef = useRef(false);
  const wheelGestureRef = useRef<WheelPageTurnHandler | null>(null);
  const pageTurnDispatcher = useMemo<PageTurnDispatcher>(() => (
    createPageTurnDispatcher({ turn: turnPage })
  ), [turnPage]);
  const keyboardRepeater = useMemo<KeyboardPageTurnRepeater>(() => (
    createKeyboardPageTurnRepeater({ turn: (direction) => pageTurnDispatcher.dispatch(direction) })
  ), [pageTurnDispatcher]);

  useEffect(() => () => pageTurnDispatcher.cancelPending(), [pageTurnDispatcher]);

  useEffect(() => {
    overlayOpenRef.current = overlayOpen;
  }, [overlayOpen]);

  useEffect(() => {
    if (!sidePanelOpen) keyboardBlockedRef.current = false;
  }, [sidePanelOpen]);

  const handlePageTurnKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target && panelRef.current?.contains(target)) {
      keyboardBlockedRef.current = true;
      return;
    }
    if (
      overlayOpenRef.current
      || keyboardBlockedRef.current
      || isEditableEventTarget(target)
    ) return;
    // A PDF answers the zoom shortcuts with its own page scale; every other
    // book leaves them to `useAppZoom`, which has already seen this event on
    // the capture phase and marked it handled.
    const zoomCommand = bookFormat === "pdf" ? appZoomCommandFor(event) : null;
    if (zoomCommand) {
      event.preventDefault();
      event.stopPropagation();
      if (zoomCommand === "reset") onPdfZoomFit();
      else onPdfZoom(zoomCommand === "in" ? 10 : -10);
      return;
    }
    if (target?.closest?.("button, a, [role='button'], [data-reader-settings]")) return;
    const settings = settingsRef.current;
    let direction: PageDirection | null = null;
    if (keyboardEventMatchesBinding(event, settings.previousPageBinding)) direction = "previous";
    else if (keyboardEventMatchesBinding(event, settings.nextPageBinding)) direction = "next";
    else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") direction = "previous";
      else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " ") direction = "next";
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey && event.key === " ") {
      direction = "previous";
    }
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    keyboardRepeater.handle(direction, event.repeat);
  }, [bookFormat, keyboardRepeater, onPdfZoom, onPdfZoomFit, panelRef, settingsRef]);

  const handlePageTurnMouseDown = useCallback((event: MouseEvent) => {
    keyboardBlockedRef.current = false;
    if (event.defaultPrevented || isEditableEventTarget(event.target)) return;
    const settings = settingsRef.current;
    const direction = mouseEventMatchesBinding(event, settings.previousPageBinding)
      ? "previous"
      : mouseEventMatchesBinding(event, settings.nextPageBinding) ? "next" : null;
    if (!direction) return;
    if (event.button === 2) suppressContextMenuUntilRef.current = Date.now() + 800;
    event.preventDefault();
    event.stopPropagation();
    pageTurnDispatcher.dispatch(direction);
  }, [pageTurnDispatcher, settingsRef]);

  const handlePageTurnContextMenu = useCallback((event: MouseEvent) => {
    if (Date.now() > suppressContextMenuUntilRef.current) return;
    suppressContextMenuUntilRef.current = 0;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    const gesture = createWheelPageTurnHandler({
      turn: (direction) => pageTurnDispatcher.dispatch(direction),
      isEnabled: () => (
        !overlayOpenRef.current
        && settingsRef.current.readingMode === "paginated"
      ),
    });
    wheelGestureRef.current = gesture;
    return () => {
      gesture.reset();
      if (wheelGestureRef.current === gesture) wheelGestureRef.current = null;
    };
  }, [pageTurnDispatcher, settingsRef]);

  const handlePageTurnWheel = useCallback((event: WheelEvent) => {
    wheelGestureRef.current?.handleWheel(event);
  }, []);

  /**
   * The swipe gesture's way in. It is recognised inside foliate's iframe, where
   * the pointer events are (`useReaderInteractions`), but it turns pages
   * through the same dispatcher as the wheel and the keyboard — so a reader
   * swiping faster than the page animation gets the same coalescing, and the
   * two inputs cannot queue against each other.
   *
   * Gated on the same two conditions as the wheel: no overlay in the way, and
   * paginated flow. In continuous flow there is no page to turn, and the
   * gesture would be competing with the scroll it is already careful to avoid.
   */
  const handleSwipePageTurn = useCallback((direction: PageDirection) => {
    if (overlayOpenRef.current) return;
    if (settingsRef.current.readingMode !== "paginated") return;
    pageTurnDispatcher.dispatch(direction);
  }, [pageTurnDispatcher, settingsRef]);

  useEffect(() => {
    const viewport = readerViewportRef.current;
    if (!viewport) return;
    window.addEventListener("keydown", handlePageTurnKeyDown);
    viewport.addEventListener("mousedown", handlePageTurnMouseDown, true);
    viewport.addEventListener("contextmenu", handlePageTurnContextMenu, true);
    viewport.addEventListener("wheel", handlePageTurnWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", handlePageTurnKeyDown);
      viewport.removeEventListener("mousedown", handlePageTurnMouseDown, true);
      viewport.removeEventListener("contextmenu", handlePageTurnContextMenu, true);
      viewport.removeEventListener("wheel", handlePageTurnWheel);
    };
  }, [
    handlePageTurnContextMenu,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnWheel,
    readerViewportRef,
  ]);

  const blockPageTurnKeyboard = useCallback(() => {
    keyboardBlockedRef.current = true;
  }, []);

  return {
    blockPageTurnKeyboard,
    handlePageTurnContextMenu,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnWheel,
    handleSwipePageTurn,
  };
}
