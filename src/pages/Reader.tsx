import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeft,
  BookOpen,
  List,
  Bot,
  Layers,
  Loader2,
  Minus,
  Plus,
  FileWarning,
  Search,
  Volume2,
} from "lucide-react";
import Button from "../components/ui/Button";
import Toast from "../components/ui/Toast";
import AiPanel from "../components/AiPanel";
import ReaderTracesPanel from "../components/ReaderTracesPanel";
import ReaderSettings from "../components/ReaderSettings";
import { openSettings } from "../components/settings-open";
import {
  getThemeStyles,
  getReaderCapabilities,
} from "../components/reader-settings";
import ReaderContextMenu from "../components/ReaderContextMenu";
import OcrReaderHud from "../components/OcrReaderHud";
import TranslationPopover from "../components/TranslationPopover";
import FootnotePopover, { type FootnotePopoverData } from "../components/FootnotePopover";
import TableOfContents from "../components/TableOfContents";
import BookSearchPanel from "../components/BookSearchPanel";
import { parseTocSavedState, type TocSavedState } from "../components/toc-state";
import TextBookReader from "../components/TextBookReader";
import { textLocation, type TextBookDocument } from "../components/text-book-location";
import { citationSearchProbes, type AnchorOutcome, type AnchorTarget } from "./reader/citationNavigation";
import { anchorQuoteCfi } from "./reader/quoteAnchoring";
import {
  crossBookReturnState,
  parseCrossBookJump,
  type CrossBookJump,
} from "./reader/crossBookJump";
import type { CitedSource, QuotedSource } from "../hooks/useAiChat";
import {
  classifySelection,
  detachedInteraction,
  isInteractiveReaderTarget,
  normalizeInteractionText,
  selectedRange,
  serializableRect,
  withInheritedContext,
  wordRangeAtPoint,
  type ReaderInteraction,
  type SerializableRect,
} from "../components/reader-interaction";
import { type HighlightMutationPlan } from "../components/highlight-ranges";
import { useReadingAssistanceSettings } from "./reader/useReadingAssistanceSettings";
import { useContextMarkState } from "./reader/useContextMarkState";
import { highlightMutationPlan, highlightRemovalPlan } from "./reader/highlight-plans";
import { useLearningCards } from "./reader/useLearningCards";
import { readerMenuAction } from "./reader/menu-actions";
import { getBook, markFinished, needsPreparation, retryPreparation, type Book } from "../hooks/useBooks";
import { getAllSettings, getBookSettings } from "../hooks/useSettings";
import type { Highlight } from "../hooks/useBookmarks";
import { LearningCardController } from "../components/learning-card";
import { loadCustomFonts } from "../components/custom-fonts";
import { notifyReadingAssistanceSettingsChanged } from "../components/reading-assistance-events";
import { type ReaderActionId } from "../components/reader-bindings";
import {
  runPageTurnTransition,
} from "../components/page-turn-transition";
import {
  getPdfOverlays,
  getReaderThemeVars,
} from "./reader/reader-theme";
import { ReadingProgressWriter } from "./reader/reading-progress-writer";
import { useBookAvailability } from "./reader/useBookAvailability";
import { useCellularDownloadConsent } from "../hooks/useCellularDownloadConsent";
import { usePageTurnInput } from "./reader/usePageTurnInput";
import { useReaderInteractions } from "./reader/useReaderInteractions";
import { useSpeech } from "../hooks/useSpeech";
import { READING_ACTIVITY_EVENT, useReadingSessionTracker } from "../hooks/useReadingSessionTracker";
import { useReadingBehaviorTracking } from "./reader/useReadingBehaviorTracking";
import type { FinalizedScreen } from "./reader/reading-behavior";
import { collectWord } from "../components/vocab/collect";
import { useReaderOcr } from "./reader/useReaderOcr";
import {
  useReaderSettingsSync,
} from "./reader/useReaderSettingsSync";
import { measureRenderedTextRect } from "./reader/reader-settings-placement";
import { useWindowSizePersistence } from "./reader/useWindowSizePersistence";
import { useSidePanelResize } from "./reader/useSidePanelResize";
import {
  useFoliateAnnotations,
  type WordMarkRule,
} from "./reader/useFoliateAnnotations";
import { useReadingHighlight } from "./reader/useReadingHighlight";
import ReadingPlaybackBar from "../components/speech/ReadingPlaybackBar";
import { cancelSpeech } from "../components/speech/player";
import type {
  FoliateView,
  ReaderPageInfo,
  TocChapter,
} from "./reader/foliate-types";
import { useFoliateView } from "./reader/useFoliateView";
import { tocUnitKind } from "./reader/chapter-pagination";
import { useReaderNavigation } from "./reader/useReaderNavigation";
import { useJumpHistory } from "./reader/useJumpHistory";
import { toggleSidePanel, type SidePanel, type TracesTab } from "./reader/side-panel";
import {
  fileStatusExplainsFailure,
  toReaderOpenError,
  type ReaderOpenError,
} from "./reader/reader-open-error";
import { useReaderFileDiagnosis } from "./reader/useReaderFileDiagnosis";
import ReaderDiagnosticsPanel from "../components/ReaderDiagnosticsPanel";
import { logIgnoredError } from "../utils/logIgnoredError";
import { useReaderZoom } from "./reader/useReaderZoom";
import { useProgressReadout } from "./reader/useProgressReadout";
import { chaptersToTicks, type ScrubberTick } from "./reader/progress-scrubber-math";
import ProgressScrubber from "../components/ProgressScrubber";
import ReaderExportDialog from "../components/ReaderExportDialog";
import { type ReaderNoteAnchor } from "../components/ReaderNotesPanel";
import ContinuousReadAloudToolbar from "../components/ContinuousReadAloudToolbar";
import { useContinuousReadAloud } from "../hooks/useContinuousReadAloud";
import { supportsContinuousReadAloud } from "../components/continuous-read-aloud";

// Opened only on an explicit "explain" action, never on first paint of the
// reader — so the markdown renderer it needs waits for that action too.
const ExplainPopover = lazy(() => import("../components/ExplainPopover"));

function tocKind(chapter: TocChapter) {
  return tocUnitKind({ label: chapter.title });
}

/** Map a nested TOC section back to its nearest non-section reading unit. */
function logicalScopeAnchor(chapters: readonly TocChapter[], index: number): number {
  const current = chapters[index];
  if (!current) return index;
  const currentKind = tocKind(current);
  if (currentKind !== "section" && currentKind !== "unknown") return index;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const item = chapters[candidate];
    if (item.depth >= current.depth) continue;
    const kind = tocKind(item);
    if (kind === "structural" || kind === "chapter" || (currentKind === "section" && kind !== "section")) {
      return candidate;
    }
  }
  return index;
}

const appWindow = getCurrentWebviewWindow();
const isStandaloneWindow = appWindow.label.startsWith("reader-");

interface TextReaderProgressDetails {
  chapterProgress: number;
  page?: ReaderPageInfo;
}

export default function Reader() {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [book, setBook] = useState<Book | null>(null);
  // The trip that brought the reader into this book from another one's chat,
  // and the two things that can go wrong with it: the sentence not being
  // findable in the chapter, and the quoted book no longer being on the shelf.
  const [crossBookJump, setCrossBookJump] = useState<CrossBookJump | null>(null);
  const [quoteAnchorMissed, setQuoteAnchorMissed] = useState(false);
  const [quoteJumpUnavailable, setQuoteJumpUnavailable] = useState<string | null>(null);
  const isTextBook = book?.render_format === "text";
  const readerFormat = book?.render_format || book?.format;
  const initialCapabilities = useMemo(
    () => getReaderCapabilities(readerFormat),
    [readerFormat],
  );
  const [openedRendition, setOpenedRendition] = useState<{
    bookId?: string;
    layout?: string;
  }>({});
  const capabilities = useMemo(
    () => getReaderCapabilities(
      readerFormat,
      openedRendition.bookId === bookId ? openedRendition.layout : undefined,
    ),
    [bookId, openedRendition, readerFormat],
  );
  const handleRenditionLayout = useCallback((layout: string | undefined) => {
    setOpenedRendition({ bookId, layout });
  }, [bookId]);
  const supportsSelection = capabilities.supportsSelection;
  const supportsManualAnnotations = capabilities.supportsManualAnnotations;
  const supportsWordMarkers = capabilities.supportsWordMarkers;
  const passiveVocabAvailable = readerFormat?.toLowerCase() === "epub"
    && capabilities.supportsReflowSettings
    && supportsWordMarkers;
  const continuousReadAloudAvailable = supportsContinuousReadAloud(
    readerFormat,
    capabilities.supportsReflowSettings,
  );
  const supportsCfiNavigation = capabilities.supportsCfiNavigation;
  const [loading, setLoading] = useState(true);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [tracesTab, setTracesTab] = useState<TracesTab>("notes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [xrayInteraction, setXrayInteraction] = useState<ReaderInteraction | null>(null);
  useEffect(() => {
    setTracesTab("notes");
    setXrayInteraction(null);
  }, [bookId]);
  // Bumped on every ⌘F, even while the panel is already open, so it re-focuses/re-selects the input.
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [tocSavedState, setTocSavedState] = useState<TocSavedState | undefined>(undefined);
  const [chapters, setChapters] = useState<TocChapter[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(-1);
  const [currentSectionIndex, setCurrentSectionIndex] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [chapterProgress, setChapterProgress] = useState(0);
  const [pageInfo, setPageInfo] = useState<ReaderPageInfo | null>(null);
  const currentCfiRef = useRef<string | null>(null);
  // P1.5/P1.6 (click-cycle readout + scrubber) are scoped to paginated EPUBs —
  // the exact boundary `getReaderCapabilities` already draws between "genuine
  // EPUB" and everything that must degrade (PDF's own page/zoom readout,
  // and text books, both keep their existing footer untouched).
  const supportsScrubber = (book?.render_format || book?.format) === "epub";
  // P1.2 search runs on `view.search()`, which only exists for the foliate
  // view — text books bypass it entirely (isTextBook), and PDF sections have
  // no `createDocument` for it to walk, so whole-book search would silently
  // find nothing there. Scoped to EPUB only, same boundary as the scrubber.
  const supportsSearch = (book?.render_format || book?.format) === "epub";
  const {
    pushJump,
    popJump,
    notifyLocationChanged,
    visible: jumpHistoryVisible,
    label: jumpHistoryLabel,
  } = useJumpHistory(bookId);
  const [progressWriter] = useState(() => new ReadingProgressWriter((finishedId) => {
    setBook((current) => current && current.id === finishedId
      ? { ...current, status: "finished", progress: 100 }
      : current);
  }));
  const [bookReady, setBookReady] = useState(false);
  const [readerError, setReaderError] = useState<ReaderOpenError | null>(null);
  const [readerRetry, setReaderRetry] = useState(0);
  const [textInitialLocation, setTextInitialLocation] = useState<string | null>(null);
  // Which book's settings read has finished — success or failure, since a
  // failed read just means the reader opens on defaults. `dbSettingsLoadedRef`
  // deliberately tracks only the success case (it gates per-book override
  // writes); this one gates the foliate open, which must happen either way.
  const [settingsSettledBookId, setSettingsSettledBookId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ReaderInteraction | null>(null);
  const [selectedNoteAnchor, setSelectedNoteAnchor] = useState<ReaderNoteAnchor | null>(null);
  const passiveVocabToggleRevisionRef = useRef(0);
  const [readerToast, setReaderToast] = useState<string | null>(null);
  const [diagnosticsPanelOpen, setDiagnosticsPanelOpen] = useState(false);
  const [showStuckHint, setShowStuckHint] = useState(false);
  const [readerRect, setReaderRect] = useState<SerializableRect | null>(null);
  const [aiContext, setAiContext] = useState<{ text: string; cfi?: string; analysis?: string; focusWord?: string } | undefined>();
  const [initialChatId, setInitialChatId] = useState<string | undefined>();
  const [activeVocabCfi, setActiveVocabCfi] = useState<string | null>(null);
  const [translation, setTranslation] = useState<{
    x: number;
    y: number;
    text: string;
    context?: string;
    cfi?: string;
  } | null>(null);
  const [customAction, setCustomAction] = useState<{
    interaction: ReaderInteraction;
    action: { name: string; prompt: string };
  } | null>(null);
  const [footnote, setFootnote] = useState<FootnotePopoverData | null>(null);
  const {
    readerSettings,
    globalReaderSettings,
    setReaderSettings,
    readerSettingsRef,
    settingsLoadedBookRef: dbSettingsLoadedRef,
    bookOverrides,
    loadReaderSettingsSources,
    handleReaderSettingsChange,
    restoreBookOverrides,
    undoRestoreBookOverrides,
    promoteBookOverrides,
    undoPromoteBookOverrides,
  } = useReaderSettingsSync(bookId);
  const {
    adoptReadingAssistanceSettings,
    autoHighlightLookupsRef,
    doubleClickQuickLookup,
    doubleClickQuickLookupRef,
    learningCardConfig,
    markMatchingWordsRef,
    markerStyle,
    markerStyleRef,
    passiveVocab,
    readerBindings,
    readerBindingsRef,
    setMarkerStyle,
    setPassiveVocab,
    showMenuShortcuts,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
  } = useReadingAssistanceSettings();
  const {
    learningCards,
    topLearningCardId,
    setTopLearningCardId,
    openLearningCard,
    closeLearningCard,
    selectionMenuRowCount,
  } = useLearningCards({ learningCardConfig, supportsManualAnnotations, onToast: setReaderToast });
  const [bindingHud, setBindingHud] = useState<string | null>(null);
  const dismissBindingHud = useCallback(() => setBindingHud(null), []);
  const bindingHudTimerRef = useRef<number | null>(null);
  const lastBindingHudRef = useRef({ message: "", shownAt: 0 });
  useEffect(() => () => {
    if (bindingHudTimerRef.current !== null) window.clearTimeout(bindingHudTimerRef.current);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<{ id: string; title: string; author: string }>("book-metadata-changed", (event) => {
      if (event.payload.id !== bookId) return;
      setBook((current) => current ? {
        ...current,
        title: event.payload.title,
        author: event.payload.author,
      } : current);
      if (isStandaloneWindow) appWindow.setTitle(event.payload.title).catch(() => {});
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bookId]);

  const settingsAnchorRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const readerViewportRef = useRef<HTMLElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  // Raw dwell/exposure collection for the future mastery/review engine
  // (docs/impls/reading-driven-mastery-and-review.md) — collection and
  // persistence only, no scoring happens here. See
  // src-tauri/migrations/037_reading_behavior.sql for the schema and
  // src/pages/reader/reading-behavior.ts for the batching logic. Declared
  // early, alongside viewRef, because openLearningInteraction/
  // handleLookupSuccess below need recordReadingOperation.
  const flushReadingBehavior = useCallback(async (screens: FinalizedScreen[]) => {
    await invoke("record_reading_behavior_batch", { screens });
  }, []);
  const currentChapterTitle = currentChapterIndex >= 0 && currentChapterIndex < chapters.length
    ? chapters[currentChapterIndex].title
    : null;
  const { recordOperation: recordReadingOperation } = useReadingBehaviorTracking({
    bookId: bookId ?? null,
    enabled: true,
    readerReady: bookReady,
    chapter: currentChapterTitle,
    viewRef,
    flush: flushReadingBehavior,
  });
  const continuousReadAloudLabels = useMemo(() => ({
    reading: t("reader.continuousReadAloud.reading"),
    paused: t("reader.continuousReadAloud.paused"),
    finished: t("reader.continuousReadAloud.finished"),
    failed: t("reader.continuousReadAloud.failed"),
    retry: t("reader.continuousReadAloud.retry"),
    restart: t("reader.continuousReadAloud.restart"),
    leaveAtEnd: t("reader.continuousReadAloud.leaveAtEnd"),
    previous: t("reader.continuousReadAloud.previous"),
    next: t("reader.continuousReadAloud.next"),
    pause: t("reader.continuousReadAloud.pause"),
    resume: t("reader.continuousReadAloud.resume"),
    stop: t("reader.continuousReadAloud.stop"),
    collapse: t("reader.continuousReadAloud.collapse"),
    expand: t("reader.continuousReadAloud.expand"),
    preparing: t("reader.continuousReadAloud.preparing"),
    lastSentence: t("reader.continuousReadAloud.lastSentence"),
    chapterProgress: t("reader.continuousReadAloud.chapterProgress"),
    position: (index: number, total: number) => t("reader.continuousReadAloud.position", { index, total }),
    timeLeft: (minutes: number) => t("reader.continuousReadAloud.timeLeft", { minutes }),
    speed: (rate: number) => t("reader.continuousReadAloud.speed", { rate }),
  }), [t]);
  const resolveExportChapter = useCallback(async (cfi: string) => (await viewRef.current?.getTOCItemOf(cfi))?.label, []);
  // Text currently visible in the reader: foliate reports the visible Range
  // with every relocate. Captured lazily at AI send time; PDFs and unloaded
  // views simply yield nothing.
  const getViewportText = useCallback((): string | undefined => {
    try {
      const range = viewRef.current?.lastLocation?.range as Range | undefined;
      const text = range?.toString().trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }, []);
  // The reader's live selection, for the AI composer to attach on its own.
  // Without this a selected sentence reached the model only if the reader
  // explicitly quoted it; a plain selection fell through to the whole viewport,
  // and the answer could not tell which sentence was being asked about.
  const getSelectionQuote = useCallback((): { text: string; cfi?: string } | undefined => {
    try {
      const view = viewRef.current;
      for (const content of view?.renderer?.getContents?.() ?? []) {
        const doc = content?.doc as Document | undefined;
        const range = doc ? selectedRange(doc) : null;
        const text = range?.toString().trim();
        if (!range || !text) continue;
        return { text, cfi: view?.getCFI(content.index, range) || undefined };
      }
    } catch {
      // A torn-down frame simply yields no selection.
    }
    return undefined;
  }, []);
  const { handlePanelResizePointerDown, panelRef, panelWidth } = useSidePanelResize(viewRef, viewerRef, sidePanel);
  const {
    zoom,
    zoomRef,
    fitPctRef,
    handleZoom,
    handleZoomFit,
    restoreSavedZoom,
  } = useReaderZoom({
    bookId,
    bookFormat: book?.format,
    viewRef,
    settingsLoadedBookRef: dbSettingsLoadedRef,
  });
  const {
    ocrAvailable,
    ocrHudOpen,
    setOcrHudOpen,
    ocrPackage,
    ocrJob,
    onMissingPdfTextIntent,
    openOcrSettings,
    startOcr,
    retryOcr,
  } = useReaderOcr({
    book,
    bookId,
    bookReady,
    pageInfo,
    setBook,
    currentCfiRef,
    viewRef,
    dismissBindingHud,
    onToast: setReaderToast,
  });

  const {
    effectiveProgressReadoutMode,
    progressReadoutText,
    cycleProgressReadoutMode,
    resetProgressReadout,
    restoreProgressReadout,
  } = useProgressReadout({
    bookId,
    supportsScrubber,
    bookReady,
    pageInfo,
    currentSectionIndex,
    progress,
    readerSettings,
  });
  const textReaderNavigateRef = useRef<((location: string, flash?: boolean) => boolean) | null>(null);

  // A short human-readable description of "here", for the jump-history entry
  // (P1.3) a push records. Kept behind a stable-identity ref wrapper because
  // it's called from long-lived closures (the foliate view's own event
  // listeners) that must not be recreated every time the chapter changes.
  const getCurrentJumpLabel = useCallback(
    () => (
      currentChapterIndex >= 0 && currentChapterIndex < chapters.length
        ? chapters[currentChapterIndex].title
        : t("reader.jumpHistory.here")
    ),
    [chapters, currentChapterIndex, t],
  );
  const getCurrentJumpLabelRef = useRef(getCurrentJumpLabel);
  useEffect(() => {
    getCurrentJumpLabelRef.current = getCurrentJumpLabel;
  }, [getCurrentJumpLabel]);
  const getCurrentLabel = useCallback(() => getCurrentJumpLabelRef.current(), []);

  // The bare navigate, with no history push — used both by `navigateToCfi`/
  // `navigateToChapter` below (which do push) and by the "return" action
  // itself (which must not push a new entry for the pop it just performed).
  const goToLocation = useCallback((location: string) => {
    if (isTextBook) textReaderNavigateRef.current?.(location);
    else viewRef.current?.goTo(location);
  }, [isTextBook]);

  const navigateToChapter = useCallback((href: string) => {
    pushJump(currentCfiRef.current, getCurrentJumpLabel());
    goToLocation(href);
  }, [getCurrentJumpLabel, goToLocation, pushJump]);

  const navigateToCfi = useCallback((cfi: string) => {
    pushJump(currentCfiRef.current, getCurrentJumpLabel());
    goToLocation(cfi);
  }, [getCurrentJumpLabel, goToLocation, pushJump]);

  /**
   * The P1.6 scrubber's commit — fired once, on pointer release (or a
   * discrete keyboard step), never while dragging. Pushes the jump-history
   * entry first, exactly like every other jump entry point, then navigates by
   * whole-book fraction (the unit the scrubber itself works in).
   */
  const handleScrubberCommit = useCallback((fraction: number) => {
    const view = viewRef.current;
    if (!view) return;
    pushJump(currentCfiRef.current, getCurrentJumpLabel());
    view.goToFraction(fraction).catch((error: unknown) => {
      logIgnoredError("reader.scrubber-navigate", error);
    });
  }, [getCurrentJumpLabel, pushJump]);

  /**
   * The return pill / ⌘[ / Alt+← action: pop the last jump and land back on
   * it. Returns whether there was anything to return to, so keyboard handlers
   * know whether to swallow the keystroke (P1.3).
   */
  const handleJumpBack = useCallback((): boolean => {
    const entry = popJump();
    if (!entry) return false;
    goToLocation(entry.location);
    return true;
  }, [goToLocation, popJump]);

  const textReaderPageNavigationRef = useRef<{ prev: () => void; next: () => void } | null>(null);
  const [textNavigationRegistration, setTextNavigationRegistration] = useState(0);
  const chaptersRef = useRef<TocChapter[]>([]);
  const pendingWordClickRef = useRef<number | null>(null);
  const pendingSelectionMenuRef = useRef<number | null>(null);
  const readerInteractionGenerationRef = useRef(0);
  const forceClickSuppressedUntilRef = useRef(0);
  const annotationClickDocumentRef = useRef<Document | null>(null);
  const {
    markState,
    contextMenuRequestRef,
    bumpContextMenuRequest,
    resetMarkState,
    dismissMarkState,
    loadMarkState,
  } = useContextMarkState(bookId, markerStyleRef);

  const handleTextBookReady = useCallback((document: TextBookDocument) => {
    const textChapters = document.toc.map((entry, sectionIndex) => ({
      title: entry.title,
      href: textLocation(entry.source_offset),
      targetHref: textLocation(entry.source_offset),
      depth: entry.depth,
      sectionIndex,
    }));
    chaptersRef.current = textChapters;
    setChapters(textChapters);
    setCurrentChapterIndex((current) => current < 0 ? 0 : current);
    setBookReady(true);
    setReaderError(null);
  }, []);

  const queueReadingProgress = useCallback((
    targetBookId: string,
    nextProgress: number,
    cfi: string,
  ) => {
    progressWriter.queue(targetBookId, nextProgress, cfi);
  }, [progressWriter]);

  // The book-finished hint's own action (docs/impls/reading-flow-decisions-2026-08-06.md
  // §2.2's fallback): the exact same command a manual "mark as finished" from
  // the shelf's context menu runs. Optimistic locally for the same reason the
  // auto-finish path above is — waiting on a refetch would leave the hint
  // sitting on screen for another render or two after the click that was
  // supposed to remove it.
  const markReaderBookFinished = useCallback(() => {
    if (!bookId) return;
    setBook((current) => current && current.id === bookId
      ? { ...current, status: "finished", progress: 100 }
      : current);
    void markFinished(bookId);
  }, [bookId]);

  useEffect(() => {
    const flush = () => { void progressWriter.flush(); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [bookId, progressWriter]);

  const handleTextBookProgress = useCallback((
    nextProgress: number,
    textLocationValue: string,
    chapterIndex: number,
    details?: TextReaderProgressDetails,
  ) => {
    setProgress(nextProgress);
    setChapterProgress(details?.chapterProgress ?? nextProgress);
    setPageInfo(details?.page ?? null);
    currentCfiRef.current = textLocationValue;
    setCurrentChapterIndex(chapterIndex);
    setCurrentSectionIndex(chapterIndex);
    if (bookId) queueReadingProgress(bookId, nextProgress, textLocationValue);
    // The text-book equivalent of foliate's `relocate` — same fade-counter feed (P1.3).
    notifyLocationChanged();
  }, [bookId, notifyLocationChanged, queueReadingProgress]);

  const cancelPendingWordClick = useCallback(() => {
    if (pendingWordClickRef.current !== null) {
      window.clearTimeout(pendingWordClickRef.current);
      pendingWordClickRef.current = null;
    }
  }, []);

  const cancelPendingSelectionMenu = useCallback(() => {
    if (pendingSelectionMenuRef.current !== null) {
      window.clearTimeout(pendingSelectionMenuRef.current);
      pendingSelectionMenuRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!readerToast) return;
    const timer = window.setTimeout(() => setReaderToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [readerToast]);

  // Surface a diagnostics escape hatch when a book sits on "Preparing book…"
  // for too long — the hang case that never reaches the error screen.
  useEffect(() => {
    setShowStuckHint(false);
    if (bookReady || !bookId) return;
    const timer = window.setTimeout(() => setShowStuckHint(true), 8000);
    return () => window.clearTimeout(timer);
  }, [bookReady, bookId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "D" || event.key === "d")) {
        event.preventDefault();
        setDiagnosticsPanelOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘[ / Ctrl+[ / Alt+← — the jump-history return (P1.3). Window-level so it
  // also covers TextBookReader, which renders directly in the main document
  // rather than an iframe; EPUB/PDF chapter documents get their own copy of
  // this same combo in useReaderInteractions.ts, since a doc-level listener
  // is the only way to catch it inside a foliate chapter's iframe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isReturnJumpShortcut = (
        ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "[")
        || (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key === "ArrowLeft")
      );
      if (!isReturnJumpShortcut) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
      event.preventDefault();
      handleJumpBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleJumpBack]);

  // ⌘F / Ctrl+F — opens the book search panel (P1.2) and focuses its input.
  // Window-level so it also covers TextBookReader; EPUB/PDF chapter documents
  // get their own copy of this same combo in useReaderInteractions.ts, since a
  // doc-level listener is the only way to catch it inside a foliate chapter's
  // iframe.
  useEffect(() => {
    if (!supportsSearch) return;
    const onKey = (event: KeyboardEvent) => {
      const isSearchShortcut = (
        (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
        && (event.key === "f" || event.key === "F")
      );
      if (!isSearchShortcut) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
      event.preventDefault();
      setSearchOpen(true);
      setTocOpen(false);
      setSettingsOpen(false);
      setSearchFocusToken((token) => token + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [supportsSearch]);

  // Cards and AI answers are lookup surfaces of their own: the same
  // double-click and selection gestures work inside them, one level deeper.
  const lookupWordInPanel = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    origin?: ReaderInteraction,
  ) => {
    cancelPendingSelectionMenu();
    if (isInteractiveReaderTarget(event.target)) return;
    const interaction = detachedInteraction(
      wordRangeAtPoint(document, event.clientX, event.clientY),
      event.currentTarget,
      "word-quick-lookup",
    );
    if (!interaction) return;
    event.preventDefault();
    setContextMenu(null);
    openLearningCard(withInheritedContext(interaction, origin));
  }, [cancelPendingSelectionMenu, openLearningCard]);

  const openPanelSelectionMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    origin?: ReaderInteraction,
  ) => {
    const root = event.currentTarget;
    cancelPendingSelectionMenu();
    pendingSelectionMenuRef.current = window.setTimeout(() => {
      pendingSelectionMenuRef.current = null;
      const found = detachedInteraction(selectedRange(document), root, "selection-menu");
      if (!found) return;
      const interaction = withInheritedContext(found, origin);
      // Nothing to show beats an empty bordered box. Selecting text is a
      // constant gesture, so this stays silent — no toast (see 5.3 of the spec).
      if (selectionMenuRowCount(interaction) === 0) return;
      resetMarkState();
      setContextMenu(interaction);
    }, 220);
  }, [cancelPendingSelectionMenu, resetMarkState, selectionMenuRowCount]);

  const openLearningInteraction = useCallback((interaction: ReaderInteraction) => {
    // A word/phrase/passage selection is itself reading engagement, whether
    // or not it goes on to open a menu or a lookup — see reading-behavior.ts.
    recordReadingOperation("selection");
    cancelPendingWordClick();
    cancelPendingSelectionMenu();
    if (interaction.trigger !== "word-quick-lookup") {
      // Same silent skip as the panel menu: an emptied action list means no menu,
      // not an empty one. Double-click lookup goes on working — it is the branch
      // below, and it never asked the menu for permission.
      if (selectionMenuRowCount(interaction) === 0) return;
      loadMarkState(interaction);
      setContextMenu(interaction);
      return;
    }
    dismissMarkState();
    setContextMenu(null);
    openLearningCard(interaction);
  }, [
    cancelPendingSelectionMenu,
    cancelPendingWordClick,
    dismissMarkState,
    loadMarkState,
    openLearningCard,
    recordReadingOperation,
    selectionMenuRowCount,
  ]);

  const handleLookupSuccess = useCallback((interaction: ReaderInteraction) => {
    // A completed lookup is the strongest engagement signal, and also the
    // §2.1/§2.4 trigger that upweights the OTHER words on this screen — see
    // reading-behavior.ts. Recorded unconditionally, ahead of the
    // auto-highlight-only logic below.
    recordReadingOperation("lookup", interaction.normalizedText || undefined);
    if (!bookId
      || interaction.kind !== "word"
      || !interaction.location
      || !autoHighlightLookupsRef.current) return;

    if (markMatchingWordsRef.current && supportsWordMarkers) {
      // Looking a word up again — often another form of one already marked —
      // must not add a second, overlapping rule. The backend answers with the
      // rule now in force and whether it wrote anything; a no-op needs no
      // repaint.
      invoke<WordMarkRule & { changed: boolean }>("ensure_word_mark_rule", {
        bookId,
        word: interaction.text,
        color: "lookup",
        matchForms: markerStyleRef.current.wordMatchScope === "forms",
      })
        .then((result) => {
          if (!result.changed) return;
          window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
        })
        .catch(() => {});
      return;
    }

    if (!supportsManualAnnotations) return;
    invoke("ensure_lookup_occurrence_mark", {
      bookId,
      word: interaction.text,
      location: interaction.location,
    }).then(() => {
      window.dispatchEvent(new CustomEvent("lookup-mark-changed", { detail: { bookId } }));
    }).catch(() => {});
  }, [
    autoHighlightLookupsRef,
    bookId,
    markMatchingWordsRef,
    markerStyleRef,
    recordReadingOperation,
    supportsManualAnnotations,
    supportsWordMarkers,
  ]);

  const handleTextBookError = useCallback((error: string) => {
    setReaderError(toReaderOpenError(error, "text"));
    setBookReady(false);
  }, []);

  const registerTextBookNavigation = useCallback((navigateText: (location: string, flash?: boolean) => boolean) => {
    textReaderNavigateRef.current = navigateText;
    setTextNavigationRegistration((value) => value + 1);
  }, []);

  const registerTextBookPageNavigation = useCallback((navigation: { prev: () => void; next: () => void }) => {
    textReaderPageNavigationRef.current = navigation;
  }, []);

  const handleTextHighlightClick = useCallback((highlight: Highlight, rect: DOMRect, fallbackText?: string) => {
    const text = highlight.text_content?.trim() || fallbackText?.trim();
    if (!text) return;
    cancelPendingWordClick();
    pendingWordClickRef.current = window.setTimeout(() => {
      pendingWordClickRef.current = null;
      openLearningInteraction({
        trigger: "selection-menu",
        kind: classifySelection(text),
        text,
        normalizedText: normalizeInteractionText(text),
        context: text,
        location: highlight.cfi_range,
        anchorRect: serializableRect(rect),
        source: "text",
        format: "text",
      });
    }, 240);
  }, [cancelPendingWordClick, openLearningInteraction]);

  const turnReaderPage = useCallback((direction: "previous" | "next") => {
    setContextMenu(null);
    const performTurn = async () => {
      if (isTextBook) {
        textReaderPageNavigationRef.current?.[direction === "previous" ? "prev" : "next"]();
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      await (direction === "previous" ? view.prev() : view.next());
    };
    const settings = readerSettingsRef.current;
    return runPageTurnTransition({
      animation: settings.readingMode === "paginated" ? settings.pageTurnAnimation : "none",
      direction,
      viewport: readerViewportRef.current,
      turn: performTurn,
    });
  }, [isTextBook, readerSettingsRef]);

  const {
    blockPageTurnKeyboard,
    handlePageTurnContextMenu,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnWheel,
  } = usePageTurnInput({
    bookFormat: book?.format,
    settingsRef: readerSettingsRef,
    readerViewportRef,
    panelRef,
    // Cards are meant to stay open while reading, so they do not block paging.
    overlayOpen: Boolean(settingsOpen || contextMenu || translation || customAction),
    sidePanelOpen: Boolean(sidePanel),
    turnPage: turnReaderPage,
    onPdfZoom: handleZoom,
    onPdfZoomFit: handleZoomFit,
  });

  const tocChapters = useMemo(() => chapters.map((chapter, i) => ({
    title: chapter.title,
    page: i + 1,
    depth: chapter.depth,
    disabled: !chapter.targetHref,
  })), [chapters]);

  // P1.6's chapter tick marks: TOC chapters mapped onto whole-book fractions
  // via the raw section start fractions foliate-js already tracks. Guarded to
  // paginated EPUBs and to a book that's actually ready, since `chapters` is
  // briefly stale (last book's) during the load transition. Computed in an
  // effect rather than a memo because it reads `viewRef.current` — a ref
  // read has to happen outside render.
  // The bar itself still answers to the "current chapter progress" toggle —
  // turning progress off has to keep turning it off, scrubber or not.
  const showScrubber = supportsScrubber && readerSettings.showChapterProgress;
  const [scrubberTicks, setScrubberTicks] = useState<ScrubberTick[]>([]);
  useEffect(() => {
    if (!showScrubber || !bookReady) {
      setScrubberTicks([]);
      return;
    }
    try {
      setScrubberTicks(chaptersToTicks(chapters, viewRef.current?.getSectionFractions?.() ?? []));
    } catch {
      setScrubberTicks([]);
    }
  }, [showScrubber, bookReady, chapters]);

  const chapterCounter = useMemo(() => {
    const readingUnits = chapters
      .map((chapter, index) => ({ chapter, index }))
      .filter(({ chapter, index }) => chapters[index + 1]?.depth <= chapter.depth || index === chapters.length - 1)
      .map(({ index }) => index);
    if (readingUnits.length === 0) return null;
    const current = readingUnits.findIndex((index) => index >= Math.max(0, currentChapterIndex));
    return {
      current: (current < 0 ? readingUnits.length - 1 : current) + 1,
      total: readingUnits.length,
    };
  }, [chapters, currentChapterIndex]);

  const currentScope = useMemo(() => {
    const anchorIndex = currentChapterIndex >= 0
      ? logicalScopeAnchor(chapters, currentChapterIndex)
      : -1;
    const current = anchorIndex >= 0 ? chapters[anchorIndex] : undefined;
    const fallback = currentSectionIndex >= 0 ? currentSectionIndex : undefined;
    const start = current?.sectionIndex ?? fallback;
    if (start === undefined || !current) {
      return { start, end: start, ambiguous: false };
    }
    // If the TOC target could not be resolved, the live Foliate section is the
    // only trustworthy scope. Do not interpret an unknown boundary as "to the
    // end of the book"; that fallback is reserved for a resolved last unit.
    if (current.sectionIndex === undefined) {
      return { start, end: start, ambiguous: false };
    }
    // Foliate's raw section index identifies an XHTML spine item, not a
    // fragment within it. If this reading unit shares that index with another
    // distinct TOC fragment, an integer range cannot isolate the requested
    // chapter safely; let the backend ask for a selection instead of sending
    // the entire XHTML file as if it were one chapter.
    const currentTarget = current.targetHref ?? current.href;
    const ambiguous = Boolean(currentTarget && chapters.some((chapter, index) => {
      if (index === anchorIndex || chapter.sectionIndex !== start) return false;
      const target = chapter.targetHref ?? chapter.href;
      // A nested fragment belongs to the same logical chapter. A distinct
      // fragment at the same or shallower TOC depth means one raw XHTML item
      // contains multiple peer reading units and cannot be isolated by an
      // integer section range.
      return Boolean(target)
        && target !== currentTarget
        && tocKind(chapter) !== "section"
        && chapter.depth <= current.depth;
    }));
    const unresolvedBoundary = chapters
      .slice(anchorIndex + 1)
      .some((chapter) => (
        chapter.depth <= current.depth
        && Boolean(chapter.targetHref ?? chapter.href)
        && chapter.sectionIndex === undefined
      ));
    // A TOC item owns the range up to the next item at the same or shallower
    // depth. Nested entries therefore stay inside their parent chapter. A
    // resolved final item has no end and therefore extends to the end of the
    // indexed book; unresolved targets were handled by the conservative
    // single-section fallback above.
    const next = chapters.slice(anchorIndex + 1).find((chapter) => (
      chapter.sectionIndex !== undefined
      && chapter.sectionIndex > start
      && chapter.depth <= current.depth
    ));
    return {
      start,
      end: next?.sectionIndex !== undefined ? next.sectionIndex - 1 : undefined,
      ambiguous: ambiguous || unresolvedBoundary,
    };
  }, [chapters, currentChapterIndex, currentSectionIndex]);

  const {
    applyAnnotations,
    applyPassiveVocabAnnotations,
    applyFoliateMarkerStyles,
    autoMarkersRef,
    clearContinuousReadingHighlight,
    clearReadingHighlight,
    flashNavigationTarget,
    refreshAnnotations,
    resetAnnotationState,
    showContinuousReadingHighlight,
    showReadingHighlight,
    wordMarkExceptionsRef,
    wordMarkWordsRef,
  } = useFoliateAnnotations({
    bookId,
    bookReady,
    isTextBook,
    isFinished: book?.status === "finished",
    supportsManualAnnotations,
    supportsWordMarkers,
    supportsCfiNavigation,
    supportsReflowSettings: capabilities.supportsReflowSettings,
    readerSettings,
    passiveVocab,
    readerSettingsRef,
    viewRef,
    markerStyle,
    markerStyleRef,
    markMatchingWordsRef,
    setMarkerStyle,
    setReaderSettings,
    textReaderNavigateRef,
    currentCfiRef,
    pushJump,
    getCurrentLabel,
    onMarkBookFinished: markReaderBookFinished,
    bookFormat: book?.format ?? "",
    openLearningCard,
    onToast: setReaderToast,
  });

  const continuousReadAloud = useContinuousReadAloud({
    bookId: continuousReadAloudAvailable ? bookId : undefined,
    viewRef,
    currentCfiRef,
    showHighlight: showContinuousReadingHighlight,
    clearHighlight: clearContinuousReadingHighlight,
    clearLegacyHighlight: clearReadingHighlight,
  });
  const continuousReadAloudActive = continuousReadAloud.state.status === "loading"
    || continuousReadAloud.state.status === "playing"
    || continuousReadAloud.state.status === "paused";

  const recordReadingSession = useCallback(async (input: {
    bookId: string;
    startedAt: number;
    endedAt: number;
    activeSeconds: number;
  }) => {
    await invoke("record_reading_session", {
      input,
    });
  }, []);
  useReadingSessionTracker({
    bookId: bookId ?? null,
    enabled: true,
    readerReady: bookReady,
    record: recordReadingSession,
  });
  useEffect(() => {
    if (!bookReady) return;
    window.dispatchEvent(new Event(READING_ACTIVITY_EVENT));
  }, [bookReady, currentSectionIndex, pageInfo, progress]);

  useReadingHighlight({ viewRef, showReadingHighlight, clearReadingHighlight });

  // Reading aloud is anchored to this book's text — it paints a highlight into
  // the page and follows the audio through it — so leaving the reader ends it.
  // Nothing else does now that a dismissed card no longer cancels playback.
  useEffect(() => () => cancelSpeech(), []);

  // The X-Ray card only dismisses itself once the reader has actually landed on
  // the occurrence, so this must report the real outcome rather than "we tried".
  // `flashNavigationTarget` already returns false for an unresolvable location
  // or a block that never rendered.
  const navigateToCurrentXrayOccurrence = useCallback(
    (location: string): Promise<boolean> => flashNavigationTarget(location),
    [flashNavigationTarget],
  );

  const navigateToSource = useCallback(async (source: AnchorTarget): Promise<AnchorOutcome> => {
    if (isTextBook && source.charStart != null) {
      return await flashNavigationTarget(
        textLocation(source.charStart, source.charEnd ?? source.charStart),
      ) ? "anchored" : false;
    }
    if (book?.format === "pdf" && viewRef.current) {
      pushJump(currentCfiRef.current, getCurrentJumpLabel());
      await viewRef.current.goTo(source.sectionIndex);
      // A PDF page is the finest address the format offers, so arriving on it
      // is as anchored as a PDF citation ever gets.
      return "anchored";
    }
    const view = viewRef.current;
    if (!view) return false;
    if (Number.isInteger(source.sectionIndex)) {
      for (const probe of citationSearchProbes(source)) {
        try {
          let cfi: string | undefined;
          for await (const result of view.search({ query: probe, index: source.sectionIndex })) {
            if (result === "done") break;
            if (result.cfi) {
              cfi = result.cfi;
              break;
            }
          }
          view.clearSearch();
          if (cfi) {
            await flashNavigationTarget(cfi);
            return "anchored";
          }
        } catch {
          view.clearSearch();
        }
      }
      // Nothing matched character for character. A citation lifted off the page
      // mid-session always does; a sentence that came back out of the search
      // index often does not, because the extracted text and the rendered
      // markup disagree over punctuation, footnote markers, and soft hyphens.
      // Locate it by approximate match instead before giving up on the line.
      const anchored = await anchorQuoteCfi(view, source.sectionIndex, {
        exact: source.snippet,
        prefix: source.prefix,
        suffix: source.suffix,
        // No position hint: EPUB chunks carry no character offset at all, and
        // for the formats that do, the exact path above has already answered.
      });
      if (anchored) {
        await flashNavigationTarget(anchored);
        return "anchored";
      }
    }
    if (source.sectionHref) {
      pushJump(currentCfiRef.current, getCurrentJumpLabel());
      await view.goTo(source.sectionHref);
      return "section";
    }
    return false;
  }, [book?.format, flashNavigationTarget, getCurrentJumpLabel, isTextBook, pushJump, viewRef]);

  // Load book metadata and default settings from DB
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    dbSettingsLoadedRef.current = null;
    setSettingsSettledBookId(null);
    setLoading(true);
    setReaderError(null);
    setBook(null);
    resetAnnotationState();
    currentCfiRef.current = null;
    chaptersRef.current = [];
    setChapters([]);
    setTocSavedState(undefined);
    setCurrentChapterIndex(-1);
    setCurrentSectionIndex(-1);
    setProgress(0);
    setChapterProgress(0);
    setPageInfo(null);
    setBookReady(false);
    setTextInitialLocation(null);
    resetProgressReadout();
    getBook(bookId)
      .then((b) => {
        if (cancelled) return;
        currentCfiRef.current = b.current_cfi;
        setTextInitialLocation(b.current_cfi);
        setBook(b);
        if (isStandaloneWindow && b) {
          appWindow.setTitle(b.title);
        }
      })
      .catch(() => {
        if (!cancelled) setBook(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    Promise.all([
      getAllSettings(),
      loadCustomFonts(),
      // Per-book overrides — one row per key, the row's existence *is* the
      // override, and the only per-book store the reader has. Failing to read
      // them must not abort the load, so a book with unreadable rows simply
      // follows the global settings.
      getBookSettings(bookId).catch(() => ({} as Record<string, string>)),
    ]).then(([globalSettings, , perBookSettings]) => {
      if (cancelled) return;
      const g = globalSettings;
      adoptReadingAssistanceSettings(g);
      loadReaderSettingsSources(g, perBookSettings);
      setTocSavedState(parseTocSavedState(perBookSettings));
      restoreProgressReadout(perBookSettings);
      restoreSavedZoom();
      dbSettingsLoadedRef.current = bookId;
    }).catch(() => {}).finally(() => {
      // Releases the foliate open (see `settingsReady` in useFoliateView). The
      // open bakes these settings in, so letting it start first meant opening
      // the book once on defaults and again the moment this landed.
      if (!cancelled) setSettingsSettledBookId(bookId);
    });
    return () => {
      cancelled = true;
    };
  }, [
    adoptReadingAssistanceSettings,
    bookId,
    dbSettingsLoadedRef,
    loadReaderSettingsSources,
    readerSettingsRef,
    resetAnnotationState,
    resetProgressReadout,
    restoreProgressReadout,
    restoreSavedZoom,
    setReaderSettings,
  ]);

  useWindowSizePersistence(bookId, isStandaloneWindow);
  const { availabilityState, retryAvailability } = useBookAvailability(book, setBook);
  const { dialog: cellularConsentDialog, requestConsent: requestCellularConsent } =
    useCellularDownloadConsent();
  useReaderFileDiagnosis(bookId, readerError, setReaderError, requestCellularConsent);
  // Bound key/mouse triggers speak without opening any card, so the reader owns
  // its own playback slot alongside the cards and the selection menu.
  const { speak: speakSelection } = useSpeech();
  const readerActionLabel = useCallback((actionId: ReaderActionId) => {
    if (actionId.startsWith("custom_")) {
      const item = Object.values(learningCardConfig.selectionMenus)
        .flat()
        .find((candidate) => candidate.id === actionId);
      return item?.name ?? t("settings.tools.bindings.actions.custom");
    }
    return t(`settings.tools.bindings.actions.${actionId}`);
  }, [learningCardConfig.selectionMenus, t]);

  const handleReaderBinding = useCallback((trigger: string, interaction: ReaderInteraction | null) => {
    const binding = readerBindingsRef.current.find((item) => item.trigger === trigger);
    if (!binding) return false;
    if (!interaction) {
      const message = t("reader.bindingNeedsSelection", { action: readerActionLabel(binding.actionId) });
      const now = Date.now();
      if (lastBindingHudRef.current.message !== message || now - lastBindingHudRef.current.shownAt >= 3_000) {
        lastBindingHudRef.current = { message, shownAt: now };
        setBindingHud(message);
        if (bindingHudTimerRef.current !== null) window.clearTimeout(bindingHudTimerRef.current);
        bindingHudTimerRef.current = window.setTimeout(() => {
          bindingHudTimerRef.current = null;
          setBindingHud(null);
        }, 1_500);
      }
      return true;
    }
    const actionId = binding.actionId;
    if (actionId === "lookup" || actionId === "explain") {
      openLearningCard({ ...interaction, trigger: "word-quick-lookup" });
    } else if (actionId === "translate") {
      setTranslation({
        x: interaction.anchorRect.right,
        y: interaction.anchorRect.top,
        text: interaction.text,
        context: interaction.context,
        cfi: interaction.location,
      });
    } else if (actionId === "speak") {
      speakSelection(interaction.text, interaction.kind);
    } else if (actionId === "copy") {
      void navigator.clipboard.writeText(interaction.text);
    } else if (actionId === "ask_ai") {
      setAiContext({ text: interaction.text, cfi: interaction.location });
      setSidePanel("ai");
    } else if (actionId === "collect" && bookId) {
      void collectWord({
        bookId,
        word: interaction.text,
        contextSentence: interaction.context,
        cfi: interaction.location,
      }).then(() => {
        window.dispatchEvent(new CustomEvent("vocab-changed", { detail: { bookId, cfi: interaction.location } }));
      });
    } else if (actionId === "highlight" && bookId && interaction.location) {
      void (async () => {
        if (interaction.kind === "word" && supportsWordMarkers && markMatchingWordsRef.current) {
          await invoke("set_word_mark_rule_enabled", {
            bookId,
            word: interaction.text,
            enabled: true,
            color: "lookup",
          });
          window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
        } else {
          const highlights = await invoke<Highlight[]>("list_highlights", { bookId });
          const plan = await highlightMutationPlan(interaction, highlights);
          if (plan) await invoke("replace_highlights", {
            bookId,
            removeIds: plan.removeIds,
            additions: plan.additions,
          });
          window.dispatchEvent(new CustomEvent("highlight-changed", { detail: { bookId } }));
        }
        await refreshAnnotations();
      })().catch((error) => console.error("Failed to run bound highlight action:", error));
    } else if (actionId.startsWith("custom_")) {
      const item = Object.values(learningCardConfig.selectionMenus)
        .flat()
        .find((candidate) => candidate.id === actionId && candidate.name && candidate.prompt);
      if (item?.name && item.prompt) {
        setCustomAction({ interaction, action: { name: item.name, prompt: item.prompt } });
      }
    }
    setContextMenu(null);
    return true;
  }, [
    bookId,
    learningCardConfig.selectionMenus,
    markMatchingWordsRef,
    openLearningCard,
    readerActionLabel,
    readerBindingsRef,
    refreshAnnotations,
    speakSelection,
    supportsWordMarkers,
    t,
  ]);
  const handleOpenSearch = useCallback(() => {
    if (!supportsSearch) return;
    setSearchOpen(true);
    setTocOpen(false);
    setSettingsOpen(false);
    setSearchFocusToken((token) => token + 1);
  }, [supportsSearch]);
  const installDocumentInteractions = useReaderInteractions({
    supportsSelection,
    pendingSelectionMenuRef,
    pendingWordClickRef,
    readerInteractionGenerationRef,
    forceClickSuppressedUntilRef,
    annotationClickDocumentRef,
    doubleClickQuickLookupRef,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
    cancelPendingSelectionMenu,
    cancelPendingWordClick,
    openLearningInteraction,
    setContextMenu,
    onMissingPdfTextIntent,
    handleZoom,
    handleZoomFit,
    handlePageTurnKeyDown,
    handlePageTurnMouseDown,
    handlePageTurnContextMenu,
    handlePageTurnWheel,
    handleReaderBinding,
    onReturnJump: handleJumpBack,
    onOpenSearch: handleOpenSearch,
  });

  useFoliateView({
    book,
    bookId,
    bookReady,
    isTextBook,
    readerRetry,
    settingsReady: settingsSettledBookId !== null && settingsSettledBookId === bookId,
    readerSettings,
    readerSettingsRef,
    initialCapabilities,
    capabilities,
    onRenditionLayout: handleRenditionLayout,
    viewRef,
    viewerRef,
    currentCfiRef,
    chaptersRef,
    readerInteractionGenerationRef,
    pendingWordClickRef,
    annotationClickDocumentRef,
    contextMenuRequestRef,
    zoomRef,
    fitPctRef,
    markerStyleRef,
    wordMarkWordsRef,
    wordMarkExceptionsRef,
    autoMarkersRef,
    applyAnnotations,
    applyPassiveVocabAnnotations,
    applyFoliateMarkerStyles,
    installDocumentInteractions,
    queueReadingProgress,
    cancelPendingWordClick,
    cancelPendingSelectionMenu,
    openLearningInteraction,
    setBookReady,
    setReaderError,
    pushJump,
    getCurrentLabel,
    notifyLocationChanged,
    setChapters,
    setCurrentChapterIndex,
    setCurrentSectionIndex,
    setProgress,
    setChapterProgress,
    setPageInfo,
    setActiveVocabCfi,
    setTracesTab,
    setSidePanel,
    setContextMenu,
    setFootnote,
  });

  useReaderNavigation({
    bookId,
    bookReady,
    isTextBook,
    supportsCfiNavigation,
    textNavigationRegistration,
    viewRef,
    textReaderNavigateRef,
    refreshAnnotations,
    flashNavigationTarget,
    pushJump,
    getCurrentLabel,
    currentCfiRef,
    setSidePanel,
    setTracesTab,
    setInitialChatId,
  });

  useEffect(() => {
    const element = readerViewportRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setReaderRect(serializableRect(element.getBoundingClientRect()));
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Toolbar buttons toggle their own panel open/closed. Traces reopens on
  // whichever of its tabs was last active (tracesTab persists across
  // close/reopen); the AI panel has only the conversation to reopen on.
  const toggleTracesPanel = () => {
    setSidePanel((prev) => toggleSidePanel(prev, "traces"));
  };

  const toggleAiPanel = () => {
    setSidePanel((prev) => toggleSidePanel(prev, "ai"));
  };

  /** Forces the traces panel open on a specific tab — used by non-toolbar entry points (a vocab marker click, "add note" from the selection menu). */
  const openTraces = (tab: TracesTab) => {
    setTracesTab(tab);
    setSidePanel("traces");
  };

  /** Forces the AI panel open — used by every "ask AI" entry point outside the toolbar. */
  const openAiChat = () => {
    setSidePanel("ai");
  };

  // Handle navigation state from ChatsPage ("Open in Reader")
  // Supports both location.state (main window) and URL search params (standalone window)
  useEffect(() => {
    const state = location.state as { openChat?: boolean; chatId?: string } | null;
    const searchParams = new URLSearchParams(window.location.search);
    const openChat = state?.openChat || searchParams.get("openChat") === "true";
    const chatId = state?.chatId || searchParams.get("chatId") || undefined;
    if (!openChat || !bookReady) return;
    setSidePanel("ai");
    if (chatId) setInitialChatId(chatId);
    if (!isStandaloneWindow) navigate(location.pathname, { replace: true });
  }, [bookReady, location.state, location.pathname, navigate]);

  // Arriving from an example sentence in another book's chat. The jump is kept
  // in component state because the router state is cleared immediately below —
  // the return offer has to outlive it, and a reload should not re-run the jump.
  useEffect(() => {
    const jump = parseCrossBookJump(location.state);
    if (!jump || !bookReady) return;
    setCrossBookJump(jump);
    setQuoteAnchorMissed(false);
    void navigateToSource({
      sectionIndex: jump.quote.sectionIndex,
      sectionHref: jump.quote.sectionHref,
      snippet: jump.quote.text,
      prefix: jump.quote.prefix,
      suffix: jump.quote.suffix,
    }).then((outcome) => {
      // Landed in the chapter but not on the sentence: say so rather than let
      // the reader hunt down a page for a line that may not be printed there
      // quite as the answer quoted it.
      if (outcome !== "anchored") setQuoteAnchorMissed(true);
    }).catch(() => setQuoteAnchorMissed(true));
    if (!isStandaloneWindow) navigate(location.pathname, { replace: true });
  }, [bookReady, location.state, location.pathname, navigate, navigateToSource]);

  // Handle source navigation and the optional vocabulary side panel.
  // Supports both location.state (main window) and URL search params (standalone window).
  useEffect(() => {
    const state = location.state as { openVocab?: boolean; cfi?: string; page?: number } | null;
    const searchParams = new URLSearchParams(window.location.search);
    const openVocab = state?.openVocab || searchParams.get("openVocab") === "true";
    const cfi = state?.cfi || searchParams.get("cfi") || undefined;
    const rawPage = state?.page ?? Number(searchParams.get("page"));
    const page = Number.isInteger(rawPage) && rawPage >= 0 ? rawPage : undefined;
    if (!bookReady || (!openVocab && !cfi && page == null)) return;
    if (openVocab) {
      setTracesTab("vocab");
      setSidePanel("traces");
    }
    if (cfi && supportsCfiNavigation) flashNavigationTarget(cfi).catch(() => {});
    if (page != null && book?.format === "pdf") {
      pushJump(currentCfiRef.current, getCurrentJumpLabel());
      viewRef.current?.goTo(page).catch(() => {});
    }
    // Clear the state so it doesn't re-trigger
    if (!isStandaloneWindow) navigate(location.pathname, { replace: true });
  }, [
    book?.format,
    bookReady,
    flashNavigationTarget,
    getCurrentJumpLabel,
    location.state,
    location.pathname,
    navigate,
    pushJump,
    supportsCfiNavigation,
    viewRef,
  ]);

  // The three panels below (TOC, settings, AI) stay mounted while closed —
  // they only hide with CSS — so they re-render on every relocate along with
  // the reader. `memo` on the components only bites if every prop keeps its
  // identity between renders, which is why these are `useCallback` rather than
  // inline arrows.
  const handleTocNavigate = useCallback((page: number) => {
    const chapter = chapters[page - 1];
    if (chapter?.targetHref) navigateToChapter(chapter.targetHref);
  }, [chapters, navigateToChapter]);

  const closeReaderSettings = useCallback(() => setSettingsOpen(false), []);

  // Read once per open, by the popover itself. Stable identity so the memoized
  // panel doesn't re-render on every relocate along with everything else here.
  const measureReaderTextRect = useCallback(
    () => measureRenderedTextRect({ view: viewRef.current, viewport: readerViewportRef.current }),
    [],
  );

  const handlePassiveVocabChange = useCallback((enabled: boolean) => {
    const previous = passiveVocab;
    const request = ++passiveVocabToggleRevisionRef.current;
    setPassiveVocab({ ...previous, enabled });
    void invoke("set_setting", { key: "passive_vocab_enabled", value: String(enabled) })
      .then(() => {
        void notifyReadingAssistanceSettingsChanged(["passive_vocab_enabled"]).catch((error) => {
          console.error("Failed to notify passive vocabulary settings change:", error);
        });
      })
      .catch(() => {
        if (passiveVocabToggleRevisionRef.current !== request) return;
        setPassiveVocab((current) => current.enabled === enabled ? previous : current);
        setReaderToast(t("readerSettings.passiveVocabSaveFailed"));
      });
  }, [passiveVocab, setPassiveVocab, t]);

  const openPassiveVocabSettings = useCallback(() => openSettings({ section: "reading", view: "passiveVocab" }), []);

  // Only ever reached through the `bookId ? … : undefined` guard at the call
  // site; the check inside is what lets the callback itself stay stable.
  const clearLookupMarks = useCallback(async () => {
    if (!bookId) return;
    await invoke("clear_lookup_marks_for_book", { bookId });
    window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
    window.dispatchEvent(new CustomEvent("lookup-mark-changed", { detail: { bookId } }));
    await refreshAnnotations();
  }, [bookId, refreshAnnotations]);

  const consumeAiContext = useCallback(() => setAiContext(undefined), []);

  const navigateToCitedCfi = useCallback((cfi: string) => {
    flashNavigationTarget(cfi).catch(() => {});
  }, [flashNavigationTarget]);

  const navigateToCitedSource = useCallback((source: CitedSource) => {
    navigateToSource(source).catch(() => {});
  }, [navigateToSource]);

  // Leave for another book, carrying the way back. The target is checked first
  // rather than navigated to hopefully: a book deleted since the answer was
  // written would otherwise land the reader on "book not found", with the book
  // they were actually reading now two steps behind them.
  const navigateToQuote = useCallback((quote: QuotedSource) => {
    void (async () => {
      try {
        await getBook(quote.bookId);
      } catch {
        setQuoteJumpUnavailable(quote.bookTitle);
        return;
      }
      const jump: CrossBookJump = {
        quote,
        from: {
          bookId: book?.id ?? "",
          cfi: currentCfiRef.current ?? undefined,
          title: book?.title ?? "",
        },
      };
      navigate(`/reader/${quote.bookId}`, { state: { crossBookJump: jump } });
    })();
  }, [book?.id, book?.title, navigate]);

  if (loading || (bookId !== undefined && book?.id !== bookId)) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        <Loader2 size={24} className="animate-spin text-text-muted" />
        <p className="text-text-muted text-[14px]">{t("reader.loading")}</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>{t("reader.bookNotFound")}</p>
      </div>
    );
  }

  const returnToLibrary = () => {
    if (isStandaloneWindow) {
      appWindow.close().catch(() => navigate("/"));
    } else {
      navigate("/");
    }
  };

  if (readerError) {
    // A parser error describes what the reader could not make of the bytes; if
    // the bytes were never there, that description is a red herring, so the
    // file's own verdict outranks it — including "damaged PDF", which is what
    // an unreadable file looks like from inside the parser.
    const fileProblem = fileStatusExplainsFailure(readerError.fileStatus);
    const invalidPdf = readerError.kind === "invalid-pdf" && !fileProblem;
    const fileMessage = readerError.fileStatus === "missing"
      ? t("reader.fileUnavailable")
      : readerError.fileStatus === "icloud_placeholder"
        ? t("reader.downloadingFromICloud")
        : t("reader.fileUnreadable");
    // Retry is worth offering whenever the file might be different next time —
    // an iCloud download finishing, a volume coming back — but not for a PDF
    // whose structure is broken, where it would fail identically.
    const showRetry = !invalidPdf;
    return (
      <>
      <div role="alert" className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        {(invalidPdf || fileProblem) && (
          <div className="flex size-10 items-center justify-center rounded-md bg-danger-bg text-danger-text">
            <FileWarning size={21} aria-hidden="true" />
          </div>
        )}
        <div className="max-w-[560px]">
          <p className="text-text-primary text-[16px] font-medium">
            {t(invalidPdf ? "reader.pdfInvalidTitle" : "reader.initializationFailed")}
          </p>
          <p className="mt-2 text-[13px] leading-5 text-text-muted break-words">
            {fileProblem ? fileMessage : invalidPdf ? t("reader.pdfInvalidDescription") : readerError.detail}
          </p>
          {/* The structure names above the raw parser message: enough to act on
              (repair and re-export rebuilds them) without putting three PDF
              internals in front of someone who only wanted to read a book.
              A file problem gets the same disclosure, but only the raw message
              — the structure explanation is about a PDF's insides, and the file
              never got far enough to have any. */}
          {(invalidPdf || (fileProblem && readerError.detail)) && (
            <details className="mx-auto mt-3 max-w-[520px] text-left">
              <summary className="cursor-pointer text-center text-[12px] text-text-secondary">
                {t("reader.errorDetails")}
              </summary>
              {invalidPdf && (
                <p className="mt-2 text-[12px] leading-5 text-text-muted">
                  {t("reader.pdfInvalidTechnical")}
                </p>
              )}
              {readerError.detail && (
                <p className="mt-2 rounded-md bg-bg-input px-3 py-2 font-mono text-[11px] leading-5 text-text-muted break-words">
                  {readerError.detail}
                </p>
              )}
            </details>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showRetry && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (needsPreparation(book) && bookId) {
                  retryPreparation(book)
                    .then(() => getBook(bookId))
                    .then((updated) => {
                      setBook(updated);
                      setReaderError(null);
                      setCurrentSectionIndex(-1);
                      setReaderRetry((value) => value + 1);
                    })
                    .catch((error) => setReaderError(
                      toReaderOpenError(error, book.render_format || book.format),
                    ));
                  return;
                }
                setReaderError(null);
                setCurrentSectionIndex(-1);
                setReaderRetry((value) => value + 1);
              }}
            >
              {t("reader.retry")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={returnToLibrary}>
            <ArrowLeft size={14} />
            {t("reader.returnToLibrary")}
          </Button>
          {showRetry && (
            <Button variant="ghost" size="sm" onClick={() => setDiagnosticsPanelOpen(true)}>
              {t("reader.diagnosticDetails")}
            </Button>
          )}
        </div>
      </div>
      <ReaderDiagnosticsPanel
        open={diagnosticsPanelOpen}
        onClose={() => setDiagnosticsPanelOpen(false)}
      />
      {cellularConsentDialog}
      </>
    );
  }

  if (availabilityState) {
    const waitingForCloud = availabilityState === "checking" || availabilityState === "icloud_placeholder";
    const message = availabilityState === "missing"
      ? t("reader.fileUnavailable")
      : availabilityState === "error"
        ? t("reader.fileCheckFailed")
        : availabilityState === "timeout"
          ? t("reader.downloadTimeout")
          : waitingForCloud
            ? t("reader.downloadingFromICloud")
            : t("reader.fileCheckFailed");
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 px-6 text-center">
        {waitingForCloud && <Loader2 size={24} className="animate-spin text-text-muted" />}
        <p className="text-text-muted text-[14px] max-w-[420px]">{message}</p>
        {!waitingForCloud && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={retryAvailability}>
              {t("reader.retry")}
            </Button>
            <Button variant="ghost" size="sm" onClick={returnToLibrary}>
              <ArrowLeft size={14} />
              {t("reader.returnToLibrary")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const toggleTocPanel = () => {
    setTocOpen((open) => !open);
    setSettingsOpen(false);
    setSearchOpen(false);
  };

  const toggleSearchPanel = () => {
    setSearchOpen((open) => !open);
    setSettingsOpen(false);
    setTocOpen(false);
    setSearchFocusToken((token) => token + 1);
  };

  /** X-Ray's primary entry point: the selection menu's "查看语境解释". Opens the traces panel on its 语境 tab with the interaction that seeds the answer. */
  const openXray = (interaction: ReaderInteraction) => {
    setContextMenu(null);
    setXrayInteraction(interaction);
    setTracesTab("xray");
    setSidePanel("traces");
  };

  return (
    <div className="flex flex-col h-screen bg-bg-page" style={getReaderThemeVars(readerSettings.theme, readerSettings.customTheme) as React.CSSProperties}>
      {/* Invisible overlay to close popovers when clicking anywhere */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => { e.preventDefault(); setSettingsOpen(false); }}
        />
      )}
      {/* Header */}
      <header
        className={`flex items-center justify-between px-section pt-titlebar-slim pb-2 shrink-0 relative select-none ${isStandaloneWindow ? "" : "bg-bg-surface border-b border-border"}`}
        style={isStandaloneWindow ? {
          backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body,
          color: getThemeStyles(readerSettings.theme, readerSettings.customTheme).text,
          borderBottom: `1px solid ${getThemeStyles(readerSettings.theme, readerSettings.customTheme).text}1a`,
        } : undefined}
      >
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-titlebar-slim" />

        {/* Left section */}
        <div className="flex items-center gap-3">
          {isStandaloneWindow ? (
            <div className="size-10 rounded-lg bg-accent flex items-center justify-center">
              <BookOpen size={18} className="text-white" />
            </div>
          ) : (
            <>
              <Button variant="icon" size="md" onClick={() => navigate("/")}>
                <ArrowLeft size={16} />
              </Button>
              <div className="w-px h-6 bg-border" />
            </>
          )}

          {isStandaloneWindow ? (
            <>
              {/* TOC on left in standalone window */}
              <div className="w-px h-6 bg-current opacity-15" />
              <Button
                variant="icon"
                size="md"
                active={tocOpen}
                className={tocOpen ? "bg-accent-bg" : ""}
                aria-label={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
                aria-expanded={tocOpen}
                title={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
                onClick={toggleTocPanel}
              >
                <List size={16} />
              </Button>
              {supportsSearch && (
                <Button
                  variant="icon"
                  size="md"
                  active={searchOpen}
                  className={searchOpen ? "bg-accent-bg" : ""}
                  aria-label={t(searchOpen ? "reader.search.close" : "reader.search.open")}
                  aria-expanded={searchOpen}
                  title={t(searchOpen ? "reader.search.close" : "reader.search.open")}
                  onClick={toggleSearchPanel}
                >
                  <Search size={16} />
                </Button>
              )}
            </>
          ) : (
            <>
              {/* Book icon + title on left in main window */}
              <div className="size-10 rounded-lg bg-accent flex items-center justify-center">
                <BookOpen size={18} className="text-white" />
              </div>
              <div className="flex flex-col">
                <h1 className="text-[16px] font-semibold text-text-primary leading-5">
                  {book.title}
                </h1>
                <span className="text-[13px] text-text-muted leading-4">
                  {book.format === "pdf"
                    ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                    : chapterCounter ? t("reader.chapterOf", chapterCounter) : ""}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Center — book title in standalone window */}
        {isStandaloneWindow && (
          <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
            <h1 className="text-[14px] font-semibold leading-5" style={{ color: "inherit" }}>
              {book.title}
            </h1>
            <span className="text-[12px] leading-4 opacity-60">
              {book.format === "pdf"
                ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                : chapterCounter ? t("reader.chapterOf", chapterCounter) : ""}
            </span>
          </div>
        )}

        {/* Right section */}
        <div className="flex items-center">
          {/* TOC button in main window */}
          {!isStandaloneWindow && (
            <>
              <Button
                variant="icon"
                size="md"
                active={tocOpen}
                className={tocOpen ? "bg-accent-bg" : ""}
                aria-label={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
                aria-expanded={tocOpen}
                title={t(tocOpen ? "reader.tocClose" : "reader.tocOpen")}
                onClick={toggleTocPanel}
              >
                <List size={16} />
              </Button>
              {supportsSearch && (
                <Button
                  variant="icon"
                  size="md"
                  active={searchOpen}
                  className={searchOpen ? "bg-accent-bg" : ""}
                  aria-label={t(searchOpen ? "reader.search.close" : "reader.search.open")}
                  aria-expanded={searchOpen}
                  title={t(searchOpen ? "reader.search.close" : "reader.search.open")}
                  onClick={toggleSearchPanel}
                >
                  <Search size={16} />
                </Button>
              )}
            </>
          )}

          {continuousReadAloudAvailable && (
            continuousReadAloud.state.collapsed && continuousReadAloud.state.status !== "idle" ? (
              <ContinuousReadAloudToolbar
                state={continuousReadAloud.state}
                labels={continuousReadAloudLabels}
                onStart={() => { void continuousReadAloud.start(continuousReadAloud.state.status === "finished"); }}
                onPause={continuousReadAloud.pause}
                onResume={continuousReadAloud.resume}
                onStop={continuousReadAloud.stop}
                onPrevious={() => { void continuousReadAloud.previous(); }}
                onNext={() => { void continuousReadAloud.next(); }}
                onRateChange={continuousReadAloud.setRate}
                onCollapsedChange={continuousReadAloud.setCollapsed}
              />
            ) : (
              <Button
                variant="icon"
                size="md"
                active={continuousReadAloud.state.status !== "idle"}
                disabled={!bookReady}
                aria-label={t("reader.continuousReadAloud.start")}
                title={t("reader.continuousReadAloud.start")}
                onClick={() => {
                  if (continuousReadAloud.state.status === "idle") void continuousReadAloud.start();
                  else continuousReadAloud.setCollapsed(true);
                }}
              >
                <Volume2 size={16} />
              </Button>
            )
          )}

          <button
            ref={settingsAnchorRef}
            onClick={() => {
              setSettingsOpen((open) => !open);
              setTocOpen(false);
              setSearchOpen(false);
            }}
            aria-label={t("reader.typography")}
            title={t("reader.typography")}
            className={`flex items-center justify-center gap-1 size-9 rounded-lg cursor-pointer transition-colors ${
              settingsOpen ? "text-accent-text" : isStandaloneWindow ? "opacity-60 hover:opacity-100" : "text-text-muted hover:bg-bg-input"
            }`}
          >
            <span className="text-[16px] font-semibold leading-6">A</span>
            <span className="text-[12px] font-semibold leading-4">A</span>
          </button>
          <ReaderSettings
            open={settingsOpen}
            onClose={closeReaderSettings}
            anchorRef={settingsAnchorRef}
            measureTextRect={measureReaderTextRect}
            settings={readerSettings}
            globalSettings={globalReaderSettings}
            onSettingsChange={handleReaderSettingsChange}
            capabilities={capabilities}
            passiveVocab={passiveVocab}
            passiveVocabAvailable={passiveVocabAvailable}
            onPassiveVocabChange={handlePassiveVocabChange}
            onOpenPassiveVocabSettings={openPassiveVocabSettings}
            bookId={bookId}
            bookOverrides={bookOverrides}
            onRestoreBookOverrides={restoreBookOverrides}
            onUndoRestoreBookOverrides={undoRestoreBookOverrides}
            onPromoteBookOverrides={promoteBookOverrides}
            onUndoPromoteBookOverrides={undoPromoteBookOverrides}
            onClearLookupMarks={bookId ? clearLookupMarks : undefined}
          />

          {supportsCfiNavigation && (
            <Button
              variant="icon"
              size="md"
              active={sidePanel === "traces"}
              aria-label={t("reader.traces.title")}
              title={t("reader.traces.title")}
              onClick={toggleTracesPanel}
            >
              <Layers size={16} />
            </Button>
          )}

          <Button
            variant="icon"
            size="md"
            active={sidePanel === "ai"}
            aria-label={t("reader.aiAssistant")}
            title={t("reader.aiAssistant")}
            onClick={toggleAiPanel}
          >
            <Bot size={16} />
          </Button>
        </div>
      </header>

      {/* Body */}
      <div
        className="flex flex-1 overflow-hidden"
        style={{ backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body }}
      >
        <TableOfContents
          open={tocOpen}
          chapters={tocChapters}
          currentPage={currentChapterIndex + 1}
          onNavigate={handleTocNavigate}
          bookId={bookId}
          savedState={tocSavedState}
        />
        {supportsSearch && bookId && (
          <BookSearchPanel
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            bookId={bookId}
            viewRef={viewRef}
            focusToken={searchFocusToken}
            onNavigateToCfi={(cfi) => {
              flashNavigationTarget(cfi).catch(() => {});
            }}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body }}>
          <main
            ref={readerViewportRef}
            className="reader-page-viewport flex-1 relative overflow-hidden"
            style={{ backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body }}
            onClick={() => {
              setSettingsOpen(false);
              // Clicks inside the iframe (text content) don't bubble out
              // through the sandbox boundary, so this fires only for clicks
              // on the margins/white space around the page — i.e. "anywhere
              // else" from the reader's perspective. Drop the in-iframe text
              // selection so the highlight doesn't linger.
              viewRef.current?.deselect?.();
            }}
          >
            {isTextBook ? (
              <TextBookReader
                key={`${book.id}:${readerRetry}`}
                bookId={book.id}
                initialLocation={textInitialLocation}
                settings={readerSettings}
                onReady={handleTextBookReady}
                onProgress={handleTextBookProgress}
                onInteraction={openLearningInteraction}
                onError={handleTextBookError}
                onRegisterNavigation={registerTextBookNavigation}
                onRegisterPageNavigation={registerTextBookPageNavigation}
                onHighlightClick={handleTextHighlightClick}
                doubleClickQuickLookup={doubleClickQuickLookup}
                markerStyle={markerStyle}
                onReaderBinding={handleReaderBinding}
              />
            ) : (
              <div
                ref={viewerRef}
                className="w-full h-full"
                style={book.format === "pdf" ? { backgroundColor: "#ffffff" } : undefined}
              />
            )}
            {book.format === "pdf" && (() => {
              const overlay = getPdfOverlays(readerSettings.theme, readerSettings.customTheme);
              if (!overlay) return null;
              return overlay.layers.map((style, i) => (
                <div
                  key={i}
                  className="z-10 pointer-events-none absolute inset-0"
                  style={style}
                />
              ));
            })()}
            {(ocrAvailable && ocrHudOpen) || bindingHud ? (
              <div className="pointer-events-none absolute bottom-5 left-1/2 z-40 flex w-full -translate-x-1/2 justify-center px-3">
                {ocrAvailable && ocrHudOpen ? (
                  <OcrReaderHud
                    packageStatus={ocrPackage.status}
                    packageError={ocrPackage.errorCode}
                    job={ocrJob.job}
                    jobError={ocrJob.errorCode}
                    busyAction={ocrJob.action}
                    onOpenSettings={() => void openOcrSettings()}
                    onStart={startOcr}
                    onCancel={() => void ocrJob.cancel().catch(() => {})}
                    onRetry={retryOcr}
                    onDismiss={() => setOcrHudOpen(false)}
                  />
                ) : (
                  <div
                    role="status"
                    className="max-w-[min(520px,calc(100%_-_24px))] rounded-md bg-[#18181B]/90 px-3 py-2 text-center text-[12px] leading-5 text-white shadow-popover"
                  >
                    {bindingHud}
                  </div>
                )}
              </div>
            ) : null}
            {!bookReady && (
              <div className="absolute inset-0 z-20 bg-bg-surface flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 size={24} className="animate-spin text-text-muted" />
                  <span className="text-[14px] text-text-muted">{t("reader.preparingBook")}</span>
                  {showStuckHint && (
                    <button
                      type="button"
                      className="mt-1 cursor-pointer text-[12px] text-accent-text underline-offset-2 hover:underline"
                      onClick={() => setDiagnosticsPanelOpen(true)}
                    >
                      {t("reader.diagnostics.stuckHint")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Arriving in a book the reader did not choose to open needs an
                explanation and a way out, both in the same strip. It stays put
                until dismissed rather than fading like the in-book return pill:
                that pill offers to undo a jump inside a book the reader knows
                they are in, and this one is the only thing saying why they are
                somewhere else. */}
            {crossBookJump && (
              <div
                role="status"
                className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-bg-surface/95 px-4 py-2 text-[12px] text-text-muted backdrop-blur"
              >
                <span>
                  {quoteAnchorMissed
                    ? t("reader.crossBookJump.arrivedAtChapter", { book: crossBookJump.from.title })
                    : t("reader.crossBookJump.arrived", { book: crossBookJump.from.title })}
                </span>
                <button
                  type="button"
                  className="cursor-pointer font-medium text-accent-text hover:opacity-70"
                  onClick={() => {
                    const target = crossBookJump;
                    setCrossBookJump(null);
                    setQuoteAnchorMissed(false);
                    navigate(`/reader/${target.from.bookId}`, {
                      state: crossBookReturnState(target),
                    });
                  }}
                >
                  {t("reader.crossBookJump.return", { book: crossBookJump.from.title })}
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-text-primary"
                  onClick={() => {
                    setCrossBookJump(null);
                    setQuoteAnchorMissed(false);
                  }}
                >
                  {t("reader.crossBookJump.dismiss")}
                </button>
              </div>
            )}
            {quoteJumpUnavailable && (
              <div
                role="status"
                className="absolute inset-x-0 bottom-20 z-30 flex justify-center px-4"
              >
                <button
                  type="button"
                  onClick={() => setQuoteJumpUnavailable(null)}
                  className="max-w-[min(520px,calc(100%_-_24px))] cursor-pointer rounded-md bg-[#18181B]/90 px-3 py-2 text-center text-[12px] leading-5 text-white shadow-popover"
                >
                  {t("reader.crossBookJump.unavailable", { book: quoteJumpUnavailable })}
                </button>
              </div>
            )}
            {jumpHistoryLabel && (
              <button
                type="button"
                onClick={handleJumpBack}
                aria-hidden={!jumpHistoryVisible}
                tabIndex={jumpHistoryVisible ? 0 : -1}
                className={`absolute bottom-4 left-6 z-20 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-accent-bg text-accent-text shadow-sm cursor-pointer transition-opacity duration-300 motion-reduce:transition-none hover:opacity-80 ${
                  jumpHistoryVisible ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
              >
                <ArrowLeft size={14} />
                <span className="text-[13px] font-medium">
                  {t("reader.jumpHistory.return", { label: jumpHistoryLabel })}
                </span>
              </button>
            )}
            {/* Read-aloud bar, floating over the page rather than above it.
                In flow it reserved ~62px, so every open and close resized the
                viewport and made the paginator re-columnize — the reader
                watched the text re-wrap for a control they open for a few
                minutes. As an overlay it costs no relayout at all. It does hide
                whatever is under it, sometimes the sentence being spoken; that
                is accepted, because the bar shows that sentence itself.

                Click is stopped here so the toolbar keeps behaving as it did
                outside <main>: bubbling would reach the viewport handler and
                deselect the reader's selection on every transport press. */}
            {continuousReadAloudAvailable
              && continuousReadAloud.state.status !== "idle"
              && !continuousReadAloud.state.collapsed && (
                <div
                  className="absolute inset-x-0 top-0 z-30"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ContinuousReadAloudToolbar
                    state={continuousReadAloud.state}
                    labels={continuousReadAloudLabels}
                    onStart={() => { void continuousReadAloud.start(continuousReadAloud.state.status === "finished"); }}
                    onPause={continuousReadAloud.pause}
                    onResume={continuousReadAloud.resume}
                    onStop={continuousReadAloud.stop}
                    onPrevious={() => { void continuousReadAloud.previous(); }}
                    onNext={() => { void continuousReadAloud.next(); }}
                    onRateChange={continuousReadAloud.setRate}
                    onCollapsedChange={continuousReadAloud.setCollapsed}
                  />
                </div>
              )}
            {!continuousReadAloudActive && <ReadingPlaybackBar />}
          </main>

          {/* Bottom progress bar */}
          <footer
            className={`px-page pb-2 pt-0 shrink-0 ${isStandaloneWindow ? "" : "bg-bg-surface"}`}
            style={isStandaloneWindow ? {
              backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body,
              color: getThemeStyles(readerSettings.theme, readerSettings.customTheme).text,
            } : undefined}
          >
            <div className="flex flex-col gap-2">
              {showScrubber ? (
                <ProgressScrubber
                  progress={progress}
                  ticks={scrubberTicks}
                  isStandaloneWindow={isStandaloneWindow}
                  onCommit={handleScrubberCommit}
                />
              ) : (
                <div className={`h-px w-full ${isStandaloneWindow ? "opacity-10" : "bg-border"}`} style={isStandaloneWindow ? { backgroundColor: "currentColor" } : undefined}>
                  {(book.format === "pdf" || readerSettings.showChapterProgress) && (
                    <div
                      className="h-full transition-all"
                      style={{ width: `${book.format === "pdf" ? progress : chapterProgress}%`, backgroundColor: isStandaloneWindow ? "currentColor" : "#9f9fa9", opacity: isStandaloneWindow ? 0.4 : undefined }}
                    />
                  )}
                </div>
              )}
              <div className="flex items-center justify-between h-8">
                <div className={`flex min-w-0 items-center gap-2 text-[12px] tabular-nums ${isStandaloneWindow ? "opacity-60" : "text-text-muted"}`}>
                  {supportsScrubber ? (
                    // P1.5's click-cycle readout. The button stays in the DOM
                    // even in "hidden" mode (no visible text) so the same
                    // click target can cycle back to "page" — a deliberate
                    // trade-off over letting the affordance vanish entirely.
                    <button
                      type="button"
                      onClick={() => cycleProgressReadoutMode(effectiveProgressReadoutMode)}
                      title={t("reader.progressReadout.toggleLabel")}
                      aria-label={progressReadoutText ? undefined : t("reader.progressReadout.toggleLabel")}
                      className={`cursor-pointer text-left hover:opacity-100 ${progressReadoutText ? "" : "min-w-[12px]"}`}
                    >
                      {progressReadoutText}
                    </button>
                  ) : (
                    <>
                      {book.format === "pdf" && pageInfo ? (
                        <span>{t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total })}</span>
                      ) : readerSettings.showChapterProgress ? (
                        <span>{t("reader.chapterProgress", { progress: chapterProgress })}</span>
                      ) : null}
                      {readerSettings.showBookProgress && book.format !== "pdf" && (
                        <span className="border-l border-current/20 pl-2">
                          {t("reader.bookProgress", { progress })}
                        </span>
                      )}
                      {readerSettings.readingMode === "paginated" && readerSettings.showPageNumbers && pageInfo && book.format !== "pdf" && (
                        <span className="border-l border-current/20 pl-2">
                          {pageInfo.visibleEnd && pageInfo.visibleEnd > pageInfo.current
                            ? t("reader.pageRangeOf", { current: pageInfo.current, end: pageInfo.visibleEnd, total: pageInfo.total })
                            : t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total })}
                        </span>
                      )}
                    </>
                  )}
                </div>
                {book.format === "pdf" && (
                  <div className="flex items-center gap-1">
                    <Button variant="icon" size="sm" onClick={() => handleZoom(-10)}>
                      <Minus size={12} />
                    </Button>
                    <button
                      type="button"
                      onClick={handleZoomFit}
                      title={t("reader.zoom.fitTooltip")}
                      className={`text-[12px] font-medium min-w-[36px] px-1 text-center tabular-nums hover:opacity-100 ${isStandaloneWindow ? "opacity-60" : "text-text-muted"} ${zoom === "fit" ? "" : "cursor-pointer"}`}
                    >
                      {zoom === "fit" ? t("reader.zoom.fit") : `${zoom}%`}
                    </button>
                    <Button variant="icon" size="sm" onClick={() => handleZoom(10)}>
                      <Plus size={12} />
                    </Button>
                  </div>
                )}
                <span className="w-8" aria-hidden="true" />
              </div>
            </div>
          </footer>
        </div>

        {sidePanel && (
          <div
            onPointerDown={handlePanelResizePointerDown}
            className="w-1 h-full shrink-0 cursor-col-resize touch-none hover:bg-accent/30 transition-colors z-10"
          />
        )}
        <div
          ref={panelRef}
          className={sidePanel ? "shrink-0 h-full" : "hidden"}
          style={{ width: panelWidth }}
          onPointerDownCapture={blockPageTurnKeyboard}
        >
          {/* No tab bar: X-Ray moved to the traces panel, so the conversation is
              the only thing in here and a one-tab switcher would be a label
              pretending to be a control. The panel gains back its 45px. */}
          <div className={sidePanel === "ai" ? "flex h-full flex-col" : "hidden"}>
            <div className="relative flex-1 min-h-0">
              <div className="h-full">
                <AiPanel
                  bookId={bookId}
                  bookTitle={book.title}
                  bookAuthor={book.author}
                  currentChapter={currentChapterIndex >= 0 && currentChapterIndex < chapters.length ? chapters[currentChapterIndex].title : undefined}
                  currentSectionIndex={currentSectionIndex >= 0 ? currentSectionIndex : undefined}
                  currentScopeStartIndex={currentScope.start}
                  currentScopeEndIndex={currentScope.end}
                  currentScopeAmbiguous={currentScope.ambiguous}
                  getViewportText={getViewportText}
                  getSelectionQuote={getSelectionQuote}
                  context={aiContext}
                  initialChatId={initialChatId}
                  onContextConsumed={consumeAiContext}
                  onNavigateToCfi={navigateToCitedCfi}
                  onNavigateToSource={navigateToCitedSource}
                  onNavigateToQuote={navigateToQuote}
                  onLookupWord={lookupWordInPanel}
                  onSelectText={openPanelSelectionMenu}
                />
              </div>
            </div>
          </div>
          {supportsCfiNavigation && sidePanel === "traces" && bookId && (
            <ReaderTracesPanel
              tab={tracesTab}
              onTabChange={setTracesTab}
              vocabProps={{
                bookId,
                bookTitle: book.title,
                onNavigate: (cfi) => {
                  flashNavigationTarget(cfi).catch(() => {});
                },
                initialWordCfi: activeVocabCfi,
                onWordDetailClosed: () => setActiveVocabCfi(null),
                onExport: () => setExportOpen(true),
              }}
              notesProps={{
                bookId,
                currentCfi: () => currentCfiRef.current,
                onNavigate: navigateToCfi,
                selectedAnchor: selectedNoteAnchor,
                onSelectedAnchorHandled: () => {
                  setSelectedNoteAnchor(null);
                  viewRef.current?.deselect();
                },
                resolveChapter: resolveExportChapter,
                onExport: () => setExportOpen(true),
              }}
              xrayProps={{
                bookId,
                interaction: xrayInteraction,
                getCurrentLocation: () => currentCfiRef.current,
                currentChapter: currentChapterIndex >= 0 ? chapters[currentChapterIndex]?.title : undefined,
                progress,
                onClear: () => setXrayInteraction(null),
                onNavigate: async (source) => await navigateToSource(source) !== false,
                onNavigateCurrent: navigateToCurrentXrayOccurrence,
              }}
            />
          )}
        </div>
      </div>

      {bookId && book && <ReaderExportDialog
        open={exportOpen}
        bookId={bookId}
        bookTitle={book.title}
        onClose={() => setExportOpen(false)}
        resolveChapter={resolveExportChapter}
      />}

      {/* Context Menu */}
      {contextMenu && (
        <ReaderContextMenu
          anchorRect={contextMenu.anchorRect}
          text={contextMenu.text}
          kind={contextMenu.kind}
          marked={markState.selectionFullyMarked}
          hasBookWordMark={markState.hasBookWordMark}
          markStateLoading={markState.loading}
          bindings={readerBindings}
          showShortcuts={showMenuShortcuts}
          order={learningCardConfig.selectionMenus[contextMenu.kind]
            .filter((item) => item.enabled)
            .map((item) => readerMenuAction(item.id))}
          customActions={learningCardConfig.selectionMenus[contextMenu.kind]
            .filter((item) => item.enabled && item.id.startsWith("custom_") && item.name && item.prompt)
            .map((item) => ({ id: item.id as `custom_${string}`, name: item.name! }))}
          onCustomAction={(id) => {
            const item = learningCardConfig.selectionMenus[contextMenu.kind].find((entry) => entry.id === id);
            if (!item?.name || !item.prompt) return;
            setCustomAction({ interaction: contextMenu, action: { name: item.name, prompt: item.prompt } });
            setContextMenu(null);
          }}
          onClose={() => {
            bumpContextMenuRequest();
            setContextMenu(null);
          }}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.text);
            setContextMenu(null);
          }}
          onExplain={() => {
            openLearningCard({ ...contextMenu, trigger: "word-quick-lookup" });
            setContextMenu(null);
          }}
          onQuote={() => {
            setAiContext({
              text: contextMenu.text,
              cfi: contextMenu.location || undefined,
            });
            openAiChat();
            setContextMenu(null);
          }}
          onXray={contextMenu.location ? () => openXray(contextMenu) : undefined}
          onLookup={() => {
            openLearningCard({ ...contextMenu, trigger: "word-quick-lookup" });
            setContextMenu(null);
          }}
          onNote={contextMenu.location ? (() => {
            setSelectedNoteAnchor({
              anchorKind: "selection",
              scope: "book",
              location: contextMenu.location,
              selectedText: contextMenu.text,
            });
            openTraces("notes");
            setContextMenu(null);
          }) : undefined}
          onTranslate={() => {
            setTranslation({
              x: contextMenu.anchorRect.right,
              y: contextMenu.anchorRect.top,
              text: contextMenu.text,
              context: contextMenu.context,
              cfi: contextMenu.location || undefined,
            });
            setContextMenu(null);
          }}
          onSave={() => {
            if (!bookId) return;
            collectWord({
              bookId,
              word: contextMenu.text,
              contextSentence: contextMenu.context,
              cfi: contextMenu.location,
            }).then(() => {
              window.dispatchEvent(new CustomEvent("vocab-changed", { detail: { bookId, cfi: contextMenu.location } }));
            }).catch((error) => console.error("Failed to save selection:", error));
            setContextMenu(null);
          }}
          onToggleMark={supportsManualAnnotations && contextMenu.location ? (() => {
            const interaction = contextMenu;
            const manualFullyMarked = markState.manualSelectionFullyMarked;
            const hasManualSelectionMark = markState.hasManualSelectionMark;
            const hasLookupOccurrence = markState.hasLookupOccurrenceMark;
            const hasBookRule = markState.hasBookWordMark;
            const bookRuleExcluded = markState.bookWordMarkExcluded;
            bumpContextMenuRequest();
            setContextMenu(null);
            if (!interaction.location || !bookId) return;
            const replaceManualMarks = async (plan: HighlightMutationPlan | null) => {
              if (!plan || (plan.removeIds.length === 0 && plan.additions.length === 0)) return;
              await invoke<Highlight[]>("replace_highlights", {
                bookId,
                removeIds: plan.removeIds,
                additions: plan.additions,
              });
              window.dispatchEvent(new CustomEvent("highlight-changed", { detail: { bookId } }));
            };
            (async () => {
              const highlights = await invoke<Highlight[]>("list_highlights", { bookId });
              if (interaction.kind === "word" && markState.selectionFullyMarked) {
                if (hasLookupOccurrence) {
                  await invoke("set_lookup_occurrence_mark_enabled", {
                    bookId,
                    word: interaction.text,
                    location: interaction.location,
                    enabled: false,
                  });
                  window.dispatchEvent(new CustomEvent("lookup-mark-changed", { detail: { bookId } }));
                }
                if (hasManualSelectionMark) {
                  await replaceManualMarks(await highlightRemovalPlan(interaction, highlights));
                }
                if (hasBookRule && !bookRuleExcluded) {
                  await invoke("set_word_mark_exception", {
                    bookId,
                    word: interaction.text,
                    location: interaction.location,
                    excluded: true,
                    matchForms: markerStyleRef.current.wordMatchScope === "forms",
                  });
                  window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
                }
              } else if (interaction.kind === "word" && hasBookRule) {
                if (bookRuleExcluded) {
                  await invoke("set_word_mark_exception", {
                    bookId,
                    word: interaction.text,
                    location: interaction.location,
                    excluded: false,
                    matchForms: markerStyleRef.current.wordMatchScope === "forms",
                  });
                  window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
                } else {
                  // The fully-marked branch above owns removal. This path is
                  // retained for defensive state refreshes only.
                  return;
                }
              } else if (interaction.kind === "word"
                && !manualFullyMarked
                && supportsWordMarkers
                && markMatchingWordsRef.current) {
                await invoke("set_word_mark_rule_enabled", {
                  bookId,
                  word: interaction.text,
                  enabled: true,
                  color: "lookup",
                });
                window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
              } else if (interaction.kind === "word") {
                await replaceManualMarks(await highlightMutationPlan(interaction, highlights));
              } else {
                const plan = manualFullyMarked
                  ? await highlightRemovalPlan(interaction, highlights)
                  : await highlightMutationPlan(interaction, highlights);
                await replaceManualMarks(plan);
              }
              await refreshAnnotations();
            })().catch((err) => console.error("Failed to toggle mark:", err));
          }) : undefined}
          onRemoveBookWordMark={contextMenu.kind === "word" && markState.hasBookWordMark ? (() => {
            const interaction = contextMenu;
            // Remove the rule that is actually marking this occurrence, which
            // under form matching may be a rule on another form of the word.
            const ruleWord = markState.bookWordMarkWord ?? interaction.text;
            bumpContextMenuRequest();
            setContextMenu(null);
            if (!bookId) return;
            invoke("remove_word_mark", { bookId, word: ruleWord })
              .then(async () => {
                window.dispatchEvent(new CustomEvent("word-mark-changed", { detail: { bookId } }));
                window.dispatchEvent(new CustomEvent("lookup-mark-changed", { detail: { bookId } }));
                await refreshAnnotations();
              })
              .catch((error) => console.error("Failed to remove book word mark:", error));
          }) : undefined}
        />
      )}

      {bookId && learningCards.map((card, index) => (
        <LearningCardController
          key={card.id}
          interaction={card.interaction}
          bookId={bookId}
          bookTitle={book?.title}
          bookAuthor={book?.author}
          chapter={currentChapterIndex >= 0 && currentChapterIndex < chapters.length
            ? chapters[currentChapterIndex].title
            : undefined}
          config={learningCardConfig}
          readerRect={readerRect}
          stackIndex={index}
          elevated={card.id === topLearningCardId}
          onLookupWord={(event) => lookupWordInPanel(event, card.interaction)}
          onSelectText={(event) => openPanelSelectionMenu(event, card.interaction)}
          onClose={() => closeLearningCard(card.id)}
          onFocus={() => setTopLearningCardId(card.id)}
          onAskAi={(quote, cfi, analysis) => {
            setAiContext({ text: quote, cfi, analysis });
            openAiChat();
          }}
          onViewAllNotes={() => {
            invoke("open_library_on_main", { filter: "notes" }).catch(() => {});
          }}
          onLookupSuccess={handleLookupSuccess}
        />
      ))}

      {customAction && bookId && (
        <Suspense fallback={null}>
          <ExplainPopover
            key={`${customAction.interaction.location}:${customAction.action.name}`}
            x={customAction.interaction.anchorRect.right}
            y={customAction.interaction.anchorRect.top}
            text={customAction.interaction.text}
            sentence={customAction.interaction.context}
            bookTitle={book?.title}
            chapter={currentChapterIndex >= 0 && currentChapterIndex < chapters.length
              ? chapters[currentChapterIndex].title
              : undefined}
            bookId={bookId}
            cfi={customAction.interaction.location}
            customAction={customAction.action}
            onClose={() => setCustomAction(null)}
            onAskFollowUp={(quote, cfi, focusWord) => {
              setAiContext({ text: quote, cfi, focusWord });
              openAiChat();
            }}
          />
        </Suspense>
      )}

      {translation && (
        <TranslationPopover
          x={translation.x}
          y={translation.y}
          text={translation.text}
          context={translation.context}
          bookId={bookId!}
          bookTitle={book?.title}
          bookAuthor={book?.author}
          chapter={currentChapterIndex >= 0 && currentChapterIndex < chapters.length
            ? chapters[currentChapterIndex].title
            : undefined}
          cfi={translation.cfi}
          onClose={() => setTranslation(null)}
          onAskFollowUp={(quote, cfi, focusWord) => {
            setAiContext({ text: quote, cfi, focusWord });
            openAiChat();
          }}
        />
      )}

      {footnote && (
        <FootnotePopover
          x={footnote.x}
          y={footnote.y}
          marker={footnote.marker}
          href={footnote.href}
          contentHost={footnote.contentHost}
          contentHeight={footnote.contentHeight}
          onClose={() => setFootnote(null)}
          onJumpToSource={() => {
            // The popover itself never navigates and never pushes — only this
            // explicit "jump to source" click is a real jump (P1.3).
            pushJump(currentCfiRef.current, getCurrentJumpLabel());
            viewRef.current?.goTo(footnote.href).catch(() => {});
            setFootnote(null);
          }}
        />
      )}

      {readerToast && <Toast>{readerToast}</Toast>}
      <ReaderDiagnosticsPanel
        open={diagnosticsPanelOpen}
        onClose={() => setDiagnosticsPanelOpen(false)}
      />

    </div>
  );
}
