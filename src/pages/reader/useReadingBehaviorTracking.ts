import { useEffect, useMemo, useRef, useState } from "react";
import {
  browserScreenExposureClock,
  ScreenExposureTracker,
  type FinalizedScreen,
  type ReadingOperationKind,
} from "./reading-behavior";
import type { FoliateView } from "./foliate-types";

export interface UseReadingBehaviorTrackingOptions {
  bookId: string | null;
  enabled: boolean;
  readerReady: boolean;
  /** Free-text chapter label — chapters[currentChapterIndex].title in
   * Reader.tsx, the same source lookup_records.chapter uses. Read via a
   * ref internally so chapter changes never force the listener effect
   * below to re-attach. */
  chapter: string | null;
  viewRef: React.RefObject<FoliateView | null>;
  flush(screens: FinalizedScreen[]): Promise<unknown>;
}

export interface ReadingBehaviorTracking {
  /** Call from the reader's own interaction handlers — word selection,
   * lookup success, and (via the caller) anything else the design doc
   * lists as an operation that isn't already a `relocate` (page turn and
   * scrolling both arrive as `relocate` and need no separate call here). */
  recordOperation(kind: ReadingOperationKind, normalizedWord?: string): void;
}

interface HighlightChangedDetail {
  bookId?: string;
}

/**
 * Wires ScreenExposureTracker into the reader's lifecycle: the foliate
 * `relocate` event (which already carries the visible-viewport Range for
 * free, see useFoliateView's `getViewportText`) drives screen boundaries,
 * `highlight-changed` / `bookmark-changed` window events supply two of the
 * operation signals, and blur/hidden/pagehide force an immediate flush —
 * closely mirroring useReadingSessionTracker's shape.
 */
export function useReadingBehaviorTracking({
  bookId,
  enabled,
  readerReady,
  chapter,
  viewRef,
  flush,
}: UseReadingBehaviorTrackingOptions): ReadingBehaviorTracking {
  const [tracker] = useState(() => new ScreenExposureTracker({
    clock: browserScreenExposureClock,
    flush,
  }));

  useEffect(() => tracker.setFlush(flush), [flush, tracker]);

  const chapterRef = useRef<string | null>(chapter);
  useEffect(() => {
    chapterRef.current = chapter;
  }, [chapter]);

  const bookIdRef = useRef<string | null>(bookId);
  useEffect(() => {
    bookIdRef.current = bookId;
  }, [bookId]);

  useEffect(() => {
    tracker.setBook(enabled && readerReady ? bookId : null);
  }, [bookId, enabled, readerReady, tracker]);

  useEffect(() => {
    if (!enabled || !readerReady || !bookId) return;
    const view = viewRef.current;
    if (!view) return;

    const onRelocate = () => {
      try {
        const location = view.lastLocation;
        const range = location?.range as Range | undefined;
        const text = range?.toString();
        if (!text) return;
        tracker.noteRelocate({
          chapter: chapterRef.current,
          cfi: typeof location?.cfi === "string" ? location.cfi : null,
          visibleText: text,
        });
      } catch {
        // A torn-down or mid-navigation frame simply yields nothing —
        // the next relocate picks collection back up.
      }
    };
    const onHighlightChanged = (event: Event) => {
      const detail = (event as CustomEvent<HighlightChangedDetail>).detail;
      if (detail?.bookId && detail.bookId !== bookIdRef.current) return;
      tracker.recordOperation("annotation");
    };
    const onBookmarkChanged = (event: Event) => {
      const detail = (event as CustomEvent<HighlightChangedDetail>).detail;
      if (detail?.bookId && detail.bookId !== bookIdRef.current) return;
      tracker.recordOperation("bookmark");
    };
    const onForceFlush = () => tracker.forceFlush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") tracker.forceFlush();
    };

    view.addEventListener("relocate", onRelocate);
    window.addEventListener("highlight-changed", onHighlightChanged);
    window.addEventListener("bookmark-changed", onBookmarkChanged);
    window.addEventListener("blur", onForceFlush);
    window.addEventListener("pagehide", onForceFlush);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      view.removeEventListener("relocate", onRelocate);
      window.removeEventListener("highlight-changed", onHighlightChanged);
      window.removeEventListener("bookmark-changed", onBookmarkChanged);
      window.removeEventListener("blur", onForceFlush);
      window.removeEventListener("pagehide", onForceFlush);
      document.removeEventListener("visibilitychange", onVisibility);
      void tracker.stop();
    };
  }, [bookId, enabled, readerReady, tracker, viewRef]);

  return useMemo(
    () => ({
      recordOperation: (kind: ReadingOperationKind, normalizedWord?: string) =>
        tracker.recordOperation(kind, normalizedWord),
    }),
    [tracker]
  );
}
