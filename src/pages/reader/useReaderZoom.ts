import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { claimZoomShortcuts } from "../../services/app-zoom";
import type { FoliateView } from "./foliate-types";

interface ReaderZoomOptions {
  bookId: string | undefined;
  bookFormat: string | undefined;
  viewRef: RefObject<FoliateView | null>;
  /** Guards the persist write until this book's stored settings have loaded. */
  settingsLoadedBookRef: RefObject<string | null>;
}

/**
 * PDF page zoom: the level itself, the ⌘=/⌘-/⌘0 claim, and its per-book
 * `localStorage` round-trip.
 *
 * Kept as both state and a ref because the two readers want different things —
 * the footer renders the number, while the foliate view's own long-lived
 * listeners read the newest value without wanting to be re-created for it.
 */
export function useReaderZoom({
  bookId,
  bookFormat,
  viewRef,
  settingsLoadedBookRef,
}: ReaderZoomOptions) {
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const zoomRef = useRef<number | "fit">(zoom);
  const fitPctRef = useRef(100);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const applyZoom = useCallback((value: number | "fit") => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    renderer.setAttribute("zoom", value === "fit" ? "fit-width" : String(value / 100));
  }, [viewRef]);

  const handleZoom = useCallback((delta: number) => {
    const base = zoomRef.current === "fit" ? fitPctRef.current : zoomRef.current;
    const next = Math.min(300, Math.max(50, Math.round((base + delta) / 10) * 10));
    applyZoom(next);
    setZoom(next);
  }, [applyZoom]);

  const handleZoomFit = useCallback(() => {
    applyZoom("fit");
    setZoom("fit");
  }, [applyZoom]);

  // ⌘= / ⌘- / ⌘0 scale the whole window everywhere else in the app. On a PDF
  // they mean the page scale instead, which is the more useful answer for a
  // fixed-layout book — so the reader takes the shortcuts for as long as one
  // is open, and `useAppZoom` stands aside.
  useEffect(() => {
    if (bookFormat !== "pdf") return;
    return claimZoomShortcuts();
  }, [bookFormat]);

  /** Called from the book load once its stored settings are in hand. */
  const restoreSavedZoom = useCallback(() => {
    const savedZoom = localStorage.getItem(`reader-zoom-${bookId}`);
    if (savedZoom === "fit") {
      setZoom("fit");
      return;
    }
    const parsedZoom = savedZoom ? parseInt(savedZoom, 10) : NaN;
    if (Number.isFinite(parsedZoom) && parsedZoom >= 50 && parsedZoom <= 300) {
      setZoom(parsedZoom);
    }
  }, [bookId]);

  // Persist per-book PDF zoom after load. Debounce to avoid thrashing during
  // rapid zoom-button clicks; only write once the user settles.
  useEffect(() => {
    if (settingsLoadedBookRef.current !== bookId) return;
    if (bookFormat !== "pdf") return;
    const handle = window.setTimeout(() => {
      localStorage.setItem(`reader-zoom-${bookId}`, zoom === "fit" ? "fit" : String(zoom));
    }, 500);
    return () => window.clearTimeout(handle);
  }, [zoom, bookId, bookFormat, settingsLoadedBookRef]);

  return { zoom, zoomRef, fitPctRef, handleZoom, handleZoomFit, restoreSavedZoom };
}
