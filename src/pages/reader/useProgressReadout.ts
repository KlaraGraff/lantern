import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { logIgnoredError } from "../../utils/logIgnoredError";
import type { ReaderPageInfo } from "./foliate-types";
import {
  averageSecondsPerPage,
  averageSecondsPerPercent,
  derivePaceSample,
  minutesLeftInBook,
  minutesLeftInChapter,
  pushPaceSample,
  type PaceSample,
  type PageTurnSnapshot,
} from "./reading-pace";
import {
  nextProgressReadoutMode,
  defaultProgressReadoutMode,
  parseProgressReadoutMode,
  progressReadoutSettingKey,
  type ProgressReadoutMode,
} from "./progress-readout";

interface ProgressReadoutOptions {
  bookId: string | undefined;
  /** Paginated-EPUB only, the same boundary the scrubber draws. */
  supportsScrubber: boolean;
  bookReady: boolean;
  pageInfo: ReaderPageInfo | null;
  currentSectionIndex: number;
  progress: number;
  readerSettings: {
    showChapterProgress: boolean;
    showBookProgress: boolean;
    showPageNumbers: boolean;
  };
}

/**
 * P1.5's click-cycle progress readout, and the local reading-pace window the
 * time-left modes are computed from.
 *
 * The pace window is fed one snapshot per relocate; `derivePaceSample` rejects
 * anything that isn't an ordinary forward page turn (chapter changes, scrubber
 * and TOC jumps, and idle gaps all drop out there — see `reading-pace.ts`).
 * `pageInfo` is null for scrolled-mode EPUBs, so samples simply never
 * accumulate there and the readout stays on "calculating…", which is the
 * intended degrade rather than a wrong number.
 */
export function useProgressReadout({
  bookId,
  supportsScrubber,
  bookReady,
  pageInfo,
  currentSectionIndex,
  progress,
  readerSettings,
}: ProgressReadoutOptions) {
  const { t } = useTranslation();
  const [progressReadoutMode, setProgressReadoutMode] = useState<ProgressReadoutMode>("page");
  // Whether this book has a readout mode of its own yet. Until it does, the
  // global "progress display" toggles decide the starting mode — see
  // `defaultProgressReadoutMode`.
  const [progressReadoutSaved, setProgressReadoutSaved] = useState(false);
  const paceSnapshotRef = useRef<PageTurnSnapshot | null>(null);
  const [paceWindow, setPaceWindow] = useState<PaceSample[]>([]);

  /** Called when the reader switches books, before the new one's rows arrive. */
  const resetProgressReadout = useCallback(() => {
    setProgressReadoutMode("page");
    paceSnapshotRef.current = null;
    setPaceWindow([]);
  }, []);

  /** Called with this book's stored setting rows once they have loaded. */
  const restoreProgressReadout = useCallback((bookSettings: Record<string, string>) => {
    const saved = bookSettings[progressReadoutSettingKey];
    setProgressReadoutSaved(saved !== undefined);
    setProgressReadoutMode(parseProgressReadoutMode(saved));
  }, []);

  // Persisted per book — the same one-row-per-key store as the TOC's saved UI
  // state, written immediately since a single click (unlike TOC scroll/expand
  // state) needs no debounce.
  // Takes the mode being displayed rather than reading state, because until
  // this book has a saved preference the displayed mode is the toggle-derived
  // default, not `progressReadoutMode`.
  const cycleProgressReadoutMode = useCallback((current: ProgressReadoutMode) => {
    if (!bookId) return;
    const next = nextProgressReadoutMode(current);
    setProgressReadoutMode(next);
    setProgressReadoutSaved(true);
    invoke("set_book_settings_bulk", {
      bookId,
      settings: { [progressReadoutSettingKey]: next },
    }).catch((error: unknown) => {
      logIgnoredError("reader.progress-readout-mode-save", error);
    });
  }, [bookId]);

  useEffect(() => {
    if (!supportsScrubber || !bookReady || !pageInfo || currentSectionIndex < 0) return;
    const next: PageTurnSnapshot = {
      sectionIndex: currentSectionIndex,
      page: pageInfo.current,
      progress,
      timestampMs: Date.now(),
    };
    const sample = derivePaceSample(paceSnapshotRef.current, next);
    paceSnapshotRef.current = next;
    if (sample) setPaceWindow((prev) => pushPaceSample(prev, sample));
  }, [supportsScrubber, bookReady, pageInfo, currentSectionIndex, progress]);

  // The global progress-display toggles keep authority over the click-cycle:
  // with all three off, a book that has never had its readout clicked starts
  // hidden instead of showing the page number.
  const effectiveProgressReadoutMode = progressReadoutSaved
    ? progressReadoutMode
    : defaultProgressReadoutMode(readerSettings);
  // `null` means "render nothing" (hidden mode); every other mode always
  // renders *something* — a number once there are enough pace samples,
  // "calculating…" otherwise, never a wrong number. A plain computation (not
  // `useMemo`) — cheap enough not to need it, and it sidesteps the React
  // Compiler's manual-memoization check, which otherwise flags the
  // nested-conditional `pageInfo` property reads below as narrower than the
  // whole-object dependency a hand-written deps array would declare.
  const progressReadoutText = (() => {
    if (effectiveProgressReadoutMode === "hidden") return null;
    if (effectiveProgressReadoutMode === "page") {
      if (!pageInfo) return t("reader.bookProgress", { progress });
      return pageInfo.visibleEnd && pageInfo.visibleEnd > pageInfo.current
        ? t("reader.pageRangeOf", { current: pageInfo.current, end: pageInfo.visibleEnd, total: pageInfo.total })
        : t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total });
    }
    if (effectiveProgressReadoutMode === "chapterTime") {
      if (!pageInfo) return t("reader.progressReadout.calculating");
      const secondsPerPage = averageSecondsPerPage(paceWindow);
      const pagesLeft = Math.max(0, pageInfo.total - pageInfo.current);
      const minutes = minutesLeftInChapter(secondsPerPage, pagesLeft);
      return minutes === null
        ? t("reader.progressReadout.calculating")
        : t("reader.progressReadout.minutesLeft", { minutes });
    }
    // bookTime — whole-book percentage plus estimated time left.
    const secondsPerPercent = averageSecondsPerPercent(paceWindow);
    const percentLeft = Math.max(0, 100 - progress);
    const minutes = minutesLeftInBook(secondsPerPercent, percentLeft);
    const percentText = t("reader.bookProgress", { progress });
    return minutes === null
      ? `${percentText} · ${t("reader.progressReadout.calculating")}`
      : `${percentText} · ${t("reader.progressReadout.minutesLeft", { minutes })}`;
  })();

  return {
    effectiveProgressReadoutMode,
    progressReadoutText,
    cycleProgressReadoutMode,
    resetProgressReadout,
    restoreProgressReadout,
  };
}
