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
  ChevronLeft,
  List,
  Sparkles,
  Layers,
  Loader2,
  Minus,
  Plus,
  FileWarning,
  Search,
  Type,
  Volume2,
} from "lucide-react";
import Button from "../components/ui/Button";
import Toast from "../components/ui/Toast";
import AiPanel from "../components/AiPanel";
import ReaderTracesPanel from "../components/ReaderTracesPanel";
import ReaderSettings from "../components/ReaderSettings";
import { openSettings } from "../components/settings-open";
import { listenForSettingsChanged, notifySettingsChanged } from "../components/settings-events";
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
import ReaderZoneGuide from "../components/ReaderZoneGuide";
import { shouldShowZoneGuide, ZONE_GUIDE_SHOWN_KEY } from "./reader/zone-guide";
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
import { useWindowFramePersistence } from "./reader/useWindowFramePersistence";
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
import { chapterReadout, type BodyMatterRange } from "./reader/chapter-count";
import { useReaderNavigation } from "./reader/useReaderNavigation";
import { useJumpHistory } from "./reader/useJumpHistory";
import { toggleSidePanel, type SidePanel, type TracesTab } from "./reader/side-panel";
import { closesOnNavigate, narrowPanel, panelShellVisible, type ReaderPanelId } from "./reader/narrow-panels";
import type { TapZone } from "./reader/tap-zones";
import { isNarrowNow, useIsNarrow } from "../hooks/useIsNarrow";
import { isCoarsePointer } from "../hooks/useCoarsePointer";
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
import { platform } from "../services/platform";
import { TOP_INSET_SLIM as TOP_INSET } from "../utils/top-inset";

// The reader header reserves room for whatever the OS puts above it. On macOS
// that is the traffic lights, and the reserve doubles as the drag region. On a
// phone it is the status bar and the notch, which `pt-safe-top` reads off the
// viewport rather than guessing at. Same ternary as `Home.tsx` and
// `Sidebar.tsx` — the reader was simply the one surface that never got
// converted, which is why on Windows it alone still reserved 32px for a title
// bar that isn't there.

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
  // Width, not input type. A 900px iPad still has room to dock a panel beside
  // the page; a macOS window dragged to phone width does not. `useIsNarrow`
  // asks the same `min-width: 48rem` question `md:` asks, so the JavaScript
  // decisions below and the breakpoint-gated classes can never disagree about
  // where the reader changes shape.
  const isNarrow = useIsNarrow();
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [tracesTab, setTracesTab] = useState<TracesTab>("notes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * Whether the phone's chrome is raised over the page.
   *
   * Silent by default: a 40pt top strip and a 24pt readout, both in flow and
   * both a fixed height, and nothing else. Tapping the middle third raises two
   * floating bars carrying everything the header used to hold. They float
   * rather than sit in flow because `<main>` is their flex sibling — growing
   * the header would change the viewport's box, and foliate re-columnizes the
   * whole chapter on a width or height change. See the two bars' own comment.
   */
  const [chromeOpen, setChromeOpen] = useState(false);
  const chromeOpenRef = useRef(false);
  // One-handed mode ("both margins advance"). Global, loaded with the rest of
  // the settings below. Two copies of one fact: the ref feeds the tap-zone
  // classifier, which lives in listeners installed once per chapter document
  // and must not re-install on a toggle; the state feeds the one-time zone
  // guide's render, where reading a ref is not allowed.
  const oneHandModeRef = useRef(false);
  const [oneHandMode, setOneHandMode] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (disposed) return;
      // `null` is a deleted row (restore defaults), which means "off".
      if (values.one_hand_mode !== undefined) {
        oneHandModeRef.current = values.one_hand_mode === "true";
        setOneHandMode(values.one_hand_mode === "true");
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    chromeOpenRef.current = chromeOpen;
  }, [chromeOpen]);
  // The one-time tap-zone guide's stored flag. Starts as "true" (= already
  // shown) so nothing flashes before the settings load below reports the real
  // value; `shouldShowZoneGuide` folds in the live conditions at render.
  const [zoneGuideShownFlag, setZoneGuideShownFlag] = useState<string | undefined>("true");
  const dismissZoneGuide = useCallback(() => {
    setZoneGuideShownFlag("true");
    void invoke("set_setting", { key: ZONE_GUIDE_SHOWN_KEY, value: "true" })
      .then(() => notifySettingsChanged({ [ZONE_GUIDE_SHOWN_KEY]: "true" }))
      .catch(() => {});
  }, []);
  // A window dragged past the breakpoint gets the desktop header back, which
  // already carries every one of these controls — leaving the flag set would
  // mean the bars reappear the next time it is dragged narrow, over a page the
  // reader never asked them for.
  useEffect(() => {
    if (!isNarrow) setChromeOpen(false);
  }, [isNarrow]);
  const [xrayInteraction, setXrayInteraction] = useState<ReaderInteraction | null>(null);
  useEffect(() => {
    setTracesTab("notes");
    setXrayInteraction(null);
  }, [bookId]);
  // Bumped on every ⌘F, even while the panel is already open, so it re-focuses/re-selects the input.
  const [searchFocusToken, setSearchFocusToken] = useState(0);

  // One screen, one panel.
  //
  // A wide reader docks the TOC on the left and the AI panel on the right at
  // the same time, so their open state is three independent flags written by a
  // dozen entry points — the toolbar, ⌘F, the selection menu, a vocab marker,
  // router state arriving from another page. A narrow reader has room for one,
  // and asking each of those entry points to also close the other two would
  // mean every future one has to remember. These two effects collapse whatever
  // the callers produced instead, so a caller only ever writes its own flag.
  //
  // They cannot ping-pong: each watches only the flags it does not write, so a
  // steady state re-runs at most one of them and it writes a value already in
  // place, which React drops without a re-render.
  useEffect(() => {
    if (!isNarrow || !sidePanel) return;
    setTocOpen(false);
    setSearchOpen(false);
  }, [isNarrow, sidePanel]);

  useEffect(() => {
    if (!isNarrow || (!tocOpen && !searchOpen)) return;
    setSidePanel(null);
  }, [isNarrow, tocOpen, searchOpen]);
  const [tocSavedState, setTocSavedState] = useState<TocSavedState | undefined>(undefined);
  const [chapters, setChapters] = useState<TocChapter[]>([]);
  // Which spine sections are the book's body, so front/back matter does not
  // inflate the top bar's chapter count. Null until probed, or when the book
  // says nothing about it.
  const [bodyMatter, setBodyMatter] = useState<BodyMatterRange | null>(null);
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
  // The same node as `readerViewportRef`, kept in state so effects can wait for
  // it. A plain ref is not enough: <main> does not exist during the loading
  // return above, so a mount-time effect would find `null` and never look
  // again — which left `readerRect` null for the whole session and made the
  // learning card measure itself against the window instead of the page.
  const [readerViewportEl, setReaderViewportEl] = useState<HTMLElement | null>(null);
  const attachReaderViewport = useCallback((node: HTMLElement | null) => {
    readerViewportRef.current = node;
    setReaderViewportEl(node);
  }, []);
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
  // What the selection said just before a finger's selection had to be dropped
  // (see `clearReaderSelection`). The quote survives the highlight so the AI
  // composer can still offer it.
  const stashedSelectionRef = useRef<{ text: string; cfi?: string } | undefined>(undefined);
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
    return stashedSelectionRef.current;
  }, []);
  /**
   * iOS draws the selection highlight and its two round handles in a system
   * layer above the page, so nothing rendered by the app can cover them: the
   * selection menu closes and the highlight stays sitting on top of whatever
   * opened in its place — the AI panel, most visibly. Dropping the selection is
   * the only way to take that layer back. A mouse has no such layer and a
   * lingering highlight there is ordinary, so this is a finger-only measure.
   */
  const clearReaderSelection = useCallback(() => {
    if (!isCoarsePointer()) return;
    stashedSelectionRef.current = getSelectionQuote();
    for (const content of viewRef.current?.renderer?.getContents?.() ?? []) {
      (content?.doc as Document | undefined)?.defaultView?.getSelection()?.removeAllRanges();
    }
  }, [getSelectionQuote]);
  // The selection outlives the menu it opened, so the menu closing is when to
  // drop it — whether it closed on a tap outside, on an action, or because
  // something else took the screen. A menu opening means a fresh selection,
  // which retires the quote stashed from the previous one.
  const menuWasOpenRef = useRef(false);
  useEffect(() => {
    const open = contextMenu !== null;
    if (open) stashedSelectionRef.current = undefined;
    else if (menuWasOpenRef.current) clearReaderSelection();
    menuWasOpenRef.current = open;
  }, [contextMenu, clearReaderSelection]);
  const { handlePanelResizePointerDown, panelRef, panelWidth } = useSidePanelResize(viewRef, viewerRef, sidePanel, !isNarrow);
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

  const handleDictionaryGlance = useCallback((interaction: ReaderInteraction, definition: string) => {
    if (!bookId) return;
    // The same screen-level signal a card lookup emits, at full strength: the
    // 1.5× boost the OTHER words on this screen get is justified by "the
    // reader is working through this screen word by word", which a dictionary
    // check proves exactly as well as an AI card does. The glanced word itself
    // lands in `lookedUpWords` and so collects no boost of its own.
    recordReadingOperation("lookup", interaction.normalizedText || undefined);
    // Half a lookup's worth of demotion, plus a lifetime tally that files the
    // word into the watchlist on its fourth glance — see
    // docs/impls/dictionary-glance-mastery.md.
    invoke<{ entered_watchlist: boolean }>("record_dictionary_glance", {
      input: {
        bookId,
        word: interaction.text,
        definition,
        contextSentence: interaction.context || null,
        cfi: interaction.location || null,
      },
    }).then((outcome) => {
      if (!outcome.entered_watchlist) return;
      window.dispatchEvent(new CustomEvent("vocab-changed", { detail: { bookId, cfi: interaction.location } }));
    }).catch(() => {
      // A glance is a background signal; a failed one is not worth a toast.
    });
  }, [bookId, recordReadingOperation]);

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
    handleSwipePageTurn,
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

  /**
   * What a tap on the page does below the breakpoint (`tap-zones.ts` decides
   * which zone it landed in).
   *
   * The two paging zones go through `handleSwipePageTurn`, not through
   * `turnReaderPage` directly, so a tap inherits everything the swipe already
   * has: the dispatcher's coalescing, "no page turn while an overlay is open",
   * and the paginated-flow gate — in continuous flow there is no page to turn
   * and the outer zones simply do nothing, while the middle one still raises
   * the chrome.
   *
   * Paging by tap has a rhythm ceiling the swipe does not: each tap waits out
   * the double-click grace before it commits (see the narrow branch in
   * `useReaderInteractions`), so two taps inside that window are a double-tap —
   * the AI lookup the reader chose over fast tap-paging — not two turns. A
   * reader in a hurry can still swipe, which commits immediately.
   */
  const handleTapZone = useCallback((zone: TapZone) => {
    if (zone === "menu") {
      setChromeOpen((open) => !open);
      return;
    }
    handleSwipePageTurn(zone);
  }, [handleSwipePageTurn]);

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
  // The desktop footer's bar still answers to the "current chapter progress"
  // toggle — turning progress off has to keep turning it off, scrubber or not.
  const showScrubber = supportsScrubber && readerSettings.showChapterProgress;
  const [scrubberTicks, setScrubberTicks] = useState<ScrubberTick[]>([]);
  // Keyed to `supportsScrubber`, not to `showScrubber`: the phone's raised
  // chrome shows the scrubber whether or not the silent strip shows progress,
  // and a scrubber that came up with no chapter ticks would be a bare track.
  // Nothing renders these unless a scrubber is on screen, so computing them for
  // a reader who turned the readout off costs one map over the TOC.
  useEffect(() => {
    if (!supportsScrubber || !bookReady) {
      setScrubberTicks([]);
      return;
    }
    try {
      setScrubberTicks(chaptersToTicks(chapters, viewRef.current?.getSectionFractions?.() ?? []));
    } catch {
      setScrubberTicks([]);
    }
  }, [supportsScrubber, bookReady, chapters]);

  const chapterCounter = useMemo(
    () => chapterReadout(chapters, currentChapterIndex, bodyMatter),
    [chapters, currentChapterIndex, bodyMatter],
  );

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

  // A player collapsed while the window was wide loses its home the moment the
  // window narrows past the breakpoint: the capsule lives in the header
  // cluster, and that cluster stops rendering. Expanding on the way down is
  // what keeps pause and stop reachable — the alternative is audio playing
  // with no control anywhere on screen.
  const collapsedReadAloud = continuousReadAloud.state.collapsed;
  const setReadAloudCollapsed = continuousReadAloud.setCollapsed;
  useEffect(() => {
    if (!isNarrow || !collapsedReadAloud) return;
    setReadAloudCollapsed(false);
  }, [isNarrow, collapsedReadAloud, setReadAloudCollapsed]);

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
    setBodyMatter(null);
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
      oneHandModeRef.current = g.one_hand_mode === "true";
      setOneHandMode(g.one_hand_mode === "true");
      setZoneGuideShownFlag(g[ZONE_GUIDE_SHOWN_KEY]);
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

  useWindowFramePersistence(bookId, isStandaloneWindow);
  const { availabilityState, retryAvailability } = useBookAvailability(book, setBook);
  const { dialog: cellularConsentDialog, requestConsent: requestCellularConsent } =
    useCellularDownloadConsent();
  // The Retry button's own handler, minus the preparation branch — a book that
  // was waiting on iCloud has nothing to convert, it only ever needed its
  // bytes. Shared so an arriving download and a pressed button take the same
  // path back into the reader instead of two that can drift apart.
  const reopenBook = useCallback(() => {
    setReaderError(null);
    setCurrentSectionIndex(-1);
    setReaderRetry((value) => value + 1);
  }, [setReaderError, setCurrentSectionIndex, setReaderRetry]);
  const { download: bookDownload } = useReaderFileDiagnosis(
    bookId,
    readerError,
    setReaderError,
    requestCellularConsent,
    reopenBook,
  );
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
    chromeOpenRef,
    oneHandModeRef,
    onTapZone: handleTapZone,
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
    handleSwipePageTurn,
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
    setBodyMatter,
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
    const element = readerViewportEl;
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
  }, [readerViewportEl]);

  // The page area, for whoever needs to keep off the text — today the learning
  // card, which parks itself in a blank side margin when one is wide enough to
  // hold it. Only the reflowable paginator has margins worth docking in; the
  // fixed-layout and PDF renderers have no `pageRect` and answer `null`, which
  // sends the card back to opening beside the word.
  const getReaderPageRect = useCallback((): SerializableRect | null => {
    const rect = viewRef.current?.renderer?.pageRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return serializableRect(rect);
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
  /**
   * Hands the screen back to the page once the reader has picked a destination
   * out of a panel. A no-op wide, where the panel is docked beside the page and
   * closing it would throw away the list being worked through — see
   * `closesOnNavigate`.
   *
   * Reads the breakpoint with the unsubscribed `isNarrowNow()` rather than the
   * `isNarrow` already in scope so this keeps one identity for the life of the
   * reader. Everything it is threaded into is memoized precisely so the panels'
   * `memo` bites, and a callback that changed on a window resize would undo
   * that for every page turn afterwards.
   */
  const closeNarrowPanels = useCallback(() => {
    if (!closesOnNavigate(isNarrowNow())) return;
    setTocOpen(false);
    setSearchOpen(false);
    setSidePanel(null);
  }, []);

  const handleTocNavigate = useCallback((page: number) => {
    const chapter = chapters[page - 1];
    if (chapter?.targetHref) navigateToChapter(chapter.targetHref);
    closeNarrowPanels();
  }, [chapters, closeNarrowPanels, navigateToChapter]);

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

  // Tapping a citation in an answer means "show me that passage", which on a
  // narrow screen it cannot do while the conversation is covering it. Nothing
  // is lost by closing: the panel is hidden rather than unmounted, so the
  // conversation is exactly where it was when the reader taps ✨ again.
  const navigateToCitedCfi = useCallback((cfi: string) => {
    flashNavigationTarget(cfi).catch(() => {});
    closeNarrowPanels();
  }, [closeNarrowPanels, flashNavigationTarget]);

  const navigateToCitedSource = useCallback((source: CitedSource) => {
    navigateToSource(source).catch(() => {});
    closeNarrowPanels();
  }, [closeNarrowPanels, navigateToSource]);

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
    // The file is in iCloud and the backend is fetching it (D-013). Until that
    // watch ends, this is a wait, not a failure — the parser error underneath
    // is describing bytes that had not arrived yet, and putting a red icon and
    // "could not open" in front of a download in progress is exactly the thing
    // P5 asked to stop doing. It becomes a failure again only when the
    // download itself says so.
    const downloadEnded = bookDownload?.phase === "failed" || bookDownload?.phase === "cancelled";
    const waitingOnDownload = readerError.fileStatus === "icloud_placeholder" && !downloadEnded;
    const fileMessage = readerError.fileStatus === "missing"
      ? t("reader.fileUnavailable")
      : readerError.fileStatus === "icloud_placeholder"
        ? (downloadEnded ? t("reader.downloadFailed") : t("reader.downloadingFromICloud"))
        : t("reader.fileUnreadable");

    if (waitingOnDownload) {
      // iCloud reports no percentage for a great many downloads, so the number
      // is shown when there is one and the spinner carries the wait when there
      // is not — never a 0% that would look stalled.
      const percent = bookDownload?.percent;
      return (
        <>
        <div role="status" className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <Loader2 size={24} className="animate-spin text-text-muted" aria-hidden="true" />
          <p className="max-w-[420px] text-[14px] text-text-muted">
            {percent === undefined
              ? t("reader.downloadingFromICloud")
              : t("reader.downloadingFromICloudPercent", { percent: Math.round(percent) })}
          </p>
          <Button variant="ghost" size="sm" onClick={returnToLibrary}>
            <ArrowLeft size={14} />
            {t("reader.returnToLibrary")}
          </Button>
        </div>
        {cellularConsentDialog}
        </>
      );
    }
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
                reopenBook();
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

  /**
   * The panel a narrow reader is showing over the page, and null on a wide one
   * — where the panels dock beside the page and nothing covers it.
   */
  const coveringPanel: ReaderPanelId | null = isNarrow
    ? narrowPanel({ tocOpen, searchOpen, sidePanel })
    : null;

  /**
   * The one heading a covering panel carries, and the one thing its ⟨ button
   * is labelled to leave. Literal `t()` calls per branch so the i18n key scan
   * (tests/i18n-keys.test.ts) can see them.
   */
  const coveringPanelTitle = (panel: ReaderPanelId): string => {
    if (panel === "toc") return t("reader.tocTitle");
    if (panel === "search") return t("reader.search.title");
    if (panel === "traces") return t("reader.traces.title");
    return t("reader.aiAssistant");
  };

  /** The one way out of a panel that has taken over the screen. */
  const closeAllPanels = () => {
    setTocOpen(false);
    setSearchOpen(false);
    setSidePanel(null);
  };

  /**
   * Where a panel sits.
   *
   * Wide: a column in the body's flex row, beside the page, exactly as before.
   * Narrow: absolutely positioned over the whole reading area.
   *
   * Over rather than instead of, deliberately — the difference is invisible
   * (the panel covers the page either way) and it is the reason opening a panel
   * on a phone does not make the book jump. Taking the page's width away would
   * relayout it to zero and back, and foliate re-columnizes the whole chapter
   * on a width change: the reader would watch the text re-wrap twice per panel
   * visit and could land on a different page than they left. The overlay leaves
   * the page's box exactly where it was.
   */
  const panelShellClass = (open: boolean, width: string, covering: boolean) => (
    panelShellVisible(open, isNarrow, covering)
      // A covering panel is the whole screen, home indicator included, so it
      // owns the bottom inset itself — the reader's footer, which reserves it
      // the rest of the time, is underneath the panel and reserving nothing.
      // `covering` is only ever true below the breakpoint, so the `md:` reset
      // is belt and braces.
      ? `absolute inset-0 z-50 flex flex-col md:static md:inset-auto md:z-auto md:h-full md:shrink-0 ${covering ? "pb-safe-bottom md:pb-0" : ""} ${width}`
      : "hidden"
  );

  /**
   * The nav bar a covering panel wears. It exists only below the breakpoint,
   * where the panel is the whole screen and the toolbar button that opened it
   * is a 36px icon in the corner — technically a way out, and not one anybody
   * should have to find.
   */
  const coveringPanelBar = (panel: ReaderPanelId) => (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-bg-surface pl-1 pr-3">
      <button
        type="button"
        onClick={closeAllPanels}
        aria-label={t("reader.panelBack")}
        className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-text-secondary hover:bg-bg-input"
      >
        <ChevronLeft size={20} />
      </button>
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary">
        {coveringPanelTitle(panel)}
      </span>
    </div>
  );

  /** X-Ray's primary entry point: the selection menu's "查看语境解释". Opens the traces panel on its 语境 tab with the interaction that seeds the answer. */
  const openXray = (interaction: ReaderInteraction) => {
    setContextMenu(null);
    setXrayInteraction(interaction);
    setTracesTab("xray");
    setSidePanel("traces");
  };

  /**
   * The one line the phone's top strip carries: where the reader is.
   *
   * The chapter name is the honest answer and the first choice. A book whose
   * TOC has not resolved yet, or a PDF (which has page numbers and often no
   * outline at all), falls back to the counter the desktop header's subtitle
   * shows — the strip is 40pt of screen either way, and an empty one reads as
   * a bar that failed to load.
   */
  const narrowLocationLabel = currentChapterTitle
    ?? (book.format === "pdf"
      ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
      : chapterCounter ? t("reader.chapterOf", { ...chapterCounter }) : "");

  /**
   * The read-aloud bar covers the bottom of the page on a phone, and it carries
   * its own chapter readout — so the silent strip underneath it would be saying
   * the same thing twice, in a place the reader cannot see anyway.
   */
  const readAloudBarVisible = continuousReadAloudAvailable
    && continuousReadAloud.state.status !== "idle"
    && !continuousReadAloud.state.collapsed;

  /**
   * ...and whether it is actually on screen. The raised chrome owns the bottom
   * of a phone while it is up: both surfaces are z-30 and the chrome, later in
   * the DOM, paints straight over the transport. Rendering a control nobody can
   * see or press is worse than not rendering it — the reader taps at buttons
   * that are not there. The 朗读 key puts the chrome away, which brings the
   * transport back in the same frame.
   *
   * Kept separate from `readAloudBarVisible` on purpose: the silent strip stays
   * keyed to the state, not to this, so its contents do not flicker back in
   * underneath a bar that is about to cover them again.
   */
  const readAloudBarOnScreen = readAloudBarVisible && !(isNarrow && chromeOpen);

  /**
   * The progress readout, in the two boxes that carry it.
   *
   * `compact` is the phone's 24pt strip, whose height the layout fixed in
   * advance: the desktop row grows to 44px under `touch:` and that is exactly
   * what a fixed-height strip must not do. Same state, same handler, same text
   * in both — only the box differs.
   */
  const progressReadout = (compact: boolean) => (
    supportsScrubber ? (
      // P1.5's click-cycle readout. The button stays in the DOM even in
      // "hidden" mode (no visible text) so the same click target can cycle
      // back to "page" — a deliberate trade-off over letting the affordance
      // vanish entirely.
      <button
        type="button"
        onClick={() => cycleProgressReadoutMode(effectiveProgressReadoutMode)}
        title={t("reader.progressReadout.toggleLabel")}
        aria-label={progressReadoutText ? undefined : t("reader.progressReadout.toggleLabel")}
        className={compact
          ? `inline-flex h-6 cursor-pointer items-center justify-center px-4 ${progressReadoutText ? "" : "min-w-11"}`
          : `cursor-pointer text-left hover:opacity-100 touch:inline-flex touch:min-h-11 touch:items-center ${progressReadoutText ? "" : "min-w-[12px] touch:min-w-11"}`}
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
    )
  );

  /** A PDF's zoom controls, which the phone moves out of the silent strip and into the raised chrome. */
  const pdfZoomControls = (
    <div className="flex items-center gap-1">
      <Button variant="icon" size="sm" onClick={() => handleZoom(-10)}>
        <Minus size={12} />
      </Button>
      <button
        type="button"
        onClick={handleZoomFit}
        title={t("reader.zoom.fitTooltip")}
        className={`text-[12px] font-medium min-w-[36px] px-1 text-center tabular-nums hover:opacity-100 touch:inline-flex touch:min-h-11 touch:min-w-11 touch:items-center touch:justify-center ${isStandaloneWindow ? "opacity-60" : "text-text-muted"} ${zoom === "fit" ? "" : "cursor-pointer"}`}
      >
        {zoom === "fit" ? t("reader.zoom.fit") : `${zoom}%`}
      </button>
      <Button variant="icon" size="sm" onClick={() => handleZoom(10)}>
        <Plus size={12} />
      </Button>
    </div>
  );

  /**
   * The raised chrome's function row.
   *
   * Every key puts the chrome away before it acts. The panel it opens covers
   * the page (z-50, above these bars at z-30), so leaving them up would only
   * mean finding them still there on the way back — and the typography sheet
   * would open with the bars showing through underneath it.
   *
   * Unavailable keys grey out rather than disappear: which five controls a book
   * offers is not something a reader should have to re-learn per format, and a
   * row that changes length between books is a row nobody builds muscle memory
   * for.
   */
  const chromeActions: Array<{
    id: string;
    label: string;
    icon: typeof List;
    active: boolean;
    disabled: boolean;
    run: () => void;
  }> = [
    {
      id: "contents",
      label: t("reader.chrome.contents"),
      icon: List,
      active: tocOpen,
      disabled: chapters.length === 0,
      run: toggleTocPanel,
    },
    {
      id: "search",
      label: t("reader.chrome.search"),
      icon: Search,
      active: searchOpen,
      disabled: !supportsSearch,
      run: toggleSearchPanel,
    },
    {
      id: "traces",
      label: t("reader.chrome.traces"),
      icon: Layers,
      active: sidePanel === "traces",
      disabled: !supportsCfiNavigation,
      run: toggleTracesPanel,
    },
    {
      id: "readAloud",
      label: t("reader.chrome.readAloud"),
      icon: Volume2,
      active: continuousReadAloud.state.status !== "idle",
      disabled: !continuousReadAloudAvailable || !bookReady,
      // Always ends with a transport on screen. Idle starts one (and `start()`
      // publishes `collapsed: false` itself); anything else is already running,
      // so the only thing between the reader and the controls is the collapse a
      // wide window let them make, and the chrome that this key closes.
      run: () => {
        if (continuousReadAloud.state.status === "idle") void continuousReadAloud.start();
        else continuousReadAloud.setCollapsed(false);
      },
    },
    {
      id: "typography",
      label: t("reader.chrome.typography"),
      icon: Type,
      active: settingsOpen,
      disabled: false,
      run: () => setSettingsOpen(true),
    },
  ];

  /**
   * The raised bars have to be opaque — they sit over the page, not beside it.
   * A standalone window paints its own theme rather than the app surface, the
   * same way its header and footer do.
   */
  const chromeSurfaceStyle = isStandaloneWindow ? {
    backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body,
    color: getThemeStyles(readerSettings.theme, readerSettings.customTheme).text,
  } : undefined;

  // `relative` on the shell is the containing block for the raised chrome. The
  // two bars are absolute children of this box rather than flex siblings of
  // <main>, so opening and closing them costs no reflow inside the chapter.
  return (
    <div className="relative flex flex-col h-screen bg-bg-page" style={getReaderThemeVars(readerSettings.theme, readerSettings.customTheme) as React.CSSProperties}>
      {/* Invisible overlay to close popovers when clicking anywhere */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => { e.preventDefault(); setSettingsOpen(false); }}
        />
      )}
      {/* Header */}
      {/* Below the breakpoint this is the silent strip: 40pt, three controls,
          and a height the layout can count on. Its height is load-bearing —
          <main> is its flex sibling, so anything that changes it changes the
          viewport's box and makes foliate re-columnize the whole chapter. That
          is why the rest of the toolbar moved into a floating bar rather than
          into a taller header. */}
      <header
        className={isNarrow
          ? `flex shrink-0 relative select-none ${TOP_INSET} ${isStandaloneWindow ? "" : "bg-bg-surface border-b border-border"}`
          : `flex items-center justify-between gap-1 px-3 md:gap-0 md:px-section ${TOP_INSET} pb-2 shrink-0 relative select-none ${isStandaloneWindow ? "" : "bg-bg-surface border-b border-border"}`}
        style={isStandaloneWindow ? {
          backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body,
          color: getThemeStyles(readerSettings.theme, readerSettings.customTheme).text,
          borderBottom: `1px solid ${getThemeStyles(readerSettings.theme, readerSettings.customTheme).text}1a`,
        } : undefined}
      >
        {platform.hasTitleBarInset && (
          <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-titlebar-slim" />
        )}

        {isNarrow ? (
          <div className="flex h-10 min-w-0 flex-1 items-center gap-1 px-1">
            {/* A standalone reader window has no library to go back to — routing
                it to "/" would replace the book with the shelf inside a window
                that exists to hold one book. The desktop header solves this by
                swapping the back button for the mark; the strip does the same,
                which also keeps the title centred between two equal boxes. */}
            {isStandaloneWindow ? (
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent">
                <BookOpen size={18} className="text-white" />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => navigate("/")}
                aria-label={t("reader.returnToLibrary")}
                className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg text-text-muted"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            {/* Centred by giving the two buttons equal, fixed widths rather than
                by absolute positioning: a long chapter name then truncates
                against the buttons instead of running underneath them. */}
            <span className="min-w-0 flex-1 truncate text-center text-[12px] leading-4 text-text-muted">
              {narrowLocationLabel}
            </span>
            <button
              type="button"
              onClick={toggleAiPanel}
              aria-label={t("reader.aiAssistant")}
              className={`grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg ${
                sidePanel === "ai" ? "text-accent-text" : "text-text-muted"
              }`}
            >
              <Sparkles size={18} />
            </button>
          </div>
        ) : (
          <>
        {/* Left section */}
        <div className="flex min-w-0 items-center gap-2 md:min-w-[auto] md:gap-3">
          {isStandaloneWindow ? (
            <div className="hidden size-10 rounded-lg bg-accent md:flex items-center justify-center">
              <BookOpen size={18} className="text-white" />
            </div>
          ) : (
            <>
              {/* 36px is under the 44px both Apple and WCAG 2.5.5 ask for. The
                  header's icon buttons grow on a coarse pointer — a modality
                  question, unlike the layout above, so `touch:` and not `md:`. */}
              <Button variant="icon" size="md" className="touch:size-11" onClick={() => navigate("/")}>
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
                className={`touch:size-11 ${tocOpen ? "bg-accent-bg" : ""}`}
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
                  className={`touch:size-11 ${searchOpen ? "bg-accent-bg" : ""}`}
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
              {/* Book icon + title on left in main window. The cover square is
                  decoration — at phone width it costs 40px and says nothing the
                  title beside it does not, so it goes and the title gets the
                  room. */}
              <div className="hidden size-10 rounded-lg bg-accent md:flex items-center justify-center">
                <BookOpen size={18} className="text-white" />
              </div>
              {/* `min-w-0` + `truncate` only below the breakpoint: a wide header
                  has room to let a long title wrap, and did. */}
              <div className="flex min-w-0 flex-col md:min-w-[auto]">
                <h1 className="truncate text-[16px] font-semibold text-text-primary leading-5 md:overflow-visible md:whitespace-normal">
                  {book.title}
                </h1>
                <span className="truncate text-[13px] text-text-muted leading-4 md:overflow-visible md:whitespace-normal">
                  {book.format === "pdf"
                    ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                    : chapterCounter ? t("reader.chapterOf", { ...chapterCounter }) : ""}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Center — book title in standalone window. Absolutely centred, so it
            has no flex box to be squeezed by and would sit straight on top of
            the buttons at phone width; capped rather than hidden, because it is
            the only place a standalone window names the book. */}
        {isStandaloneWindow && (
          <div className="absolute left-1/2 max-w-[45%] -translate-x-1/2 flex flex-col items-center pointer-events-none md:max-w-none">
            <h1 className="max-w-full truncate text-[14px] font-semibold leading-5 md:overflow-visible md:whitespace-normal" style={{ color: "inherit" }}>
              {book.title}
            </h1>
            <span className="max-w-full truncate text-[12px] leading-4 opacity-60 md:overflow-visible md:whitespace-normal">
              {book.format === "pdf"
                ? pageInfo ? t("reader.pageOf", { current: pageInfo.current, total: pageInfo.total }) : ""
                : chapterCounter ? t("reader.chapterOf", { ...chapterCounter }) : ""}
            </span>
          </div>
        )}

        {/* Right section */}
        <div className="flex shrink-0 items-center">
          {/* TOC button in main window */}
          {!isStandaloneWindow && (
            <>
              <Button
                variant="icon"
                size="md"
                active={tocOpen}
                className={`touch:size-11 ${tocOpen ? "bg-accent-bg" : ""}`}
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
                  className={`touch:size-11 ${searchOpen ? "bg-accent-bg" : ""}`}
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

          {/* Read-aloud keeps its whole cluster or nothing: the collapsed
              transport is five controls in a row, which is the entire phone
              strip on its own. Below the breakpoint it lives in the raised
              chrome's function row, and once playing it has the floating bar
              over the page. */}
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
                className="touch:size-11"
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
            // `ReaderSettings` measures its popover against this button. Below
            // the breakpoint neither exists: the header is the phone strip, and
            // the settings render as a full-screen sheet that has nothing to
            // anchor to and skips the measurement entirely.
            ref={settingsAnchorRef}
            onClick={() => {
              setSettingsOpen((open) => !open);
              setTocOpen(false);
              setSearchOpen(false);
            }}
            aria-label={t("reader.typography")}
            title={t("reader.typography")}
            className={`hidden md:flex items-center justify-center gap-1 size-9 touch:size-11 rounded-lg cursor-pointer transition-colors ${
              settingsOpen ? "text-accent-text" : isStandaloneWindow ? "opacity-60 hover:opacity-100" : "text-text-muted hover:bg-bg-input"
            }`}
          >
            <span className="text-[16px] font-semibold leading-6">A</span>
            <span className="text-[12px] font-semibold leading-4">A</span>
          </button>

          {supportsCfiNavigation && (
            <Button
              variant="icon"
              size="md"
              active={sidePanel === "traces"}
              className="touch:size-11"
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
            className="touch:size-11"
            aria-label={t("reader.aiAssistant")}
            title={t("reader.aiAssistant")}
            onClick={toggleAiPanel}
          >
            <Sparkles size={16} />
          </Button>
        </div>
          </>
        )}

        {/* Outside the width branch on purpose. Below the breakpoint the
            typography controls are a full-screen sheet reached from the raised
            chrome, so they have to stay mounted even though the toolbar that
            anchors them on desktop is not rendered. */}
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
      </header>

      {/* Body */}
      {/* `relative` is what the narrow panels position against — see `panelShellClass`. */}
      <div
        className="relative flex flex-1 overflow-hidden"
        style={{ backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body }}
      >
        <div className={panelShellClass(tocOpen, "md:w-80", coveringPanel === "toc")}>
          {coveringPanel === "toc" && coveringPanelBar("toc")}
          <div className="min-h-0 flex-1">
            <TableOfContents
              open={tocOpen}
              chapters={tocChapters}
              currentPage={currentChapterIndex + 1}
              onNavigate={handleTocNavigate}
              bookId={bookId}
              savedState={tocSavedState}
            />
          </div>
        </div>
        {supportsSearch && bookId && (
          <div className={panelShellClass(searchOpen, "md:w-80", coveringPanel === "search")}>
            {coveringPanel === "search" && coveringPanelBar("search")}
            <div className="min-h-0 flex-1">
              <BookSearchPanel
                open={searchOpen}
                onClose={() => setSearchOpen(false)}
                bookId={bookId}
                viewRef={viewRef}
                focusToken={searchFocusToken}
                onNavigateToCfi={(cfi) => {
                  flashNavigationTarget(cfi).catch(() => {});
                  closeNarrowPanels();
                }}
              />
            </div>
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body }}>
          <main
            ref={attachReaderViewport}
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
                // The same handler the foliate tap-zone loop calls. Text books
                // never get that loop — `readerOpenKey()` returns null for them,
                // and they have no chapter iframe to attach listeners to — so
                // the phone's three zones have to come in through the component.
                onTapZone={handleTapZone}
                chromeOpenRef={chromeOpenRef}
                oneHandModeRef={oneHandModeRef}
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
                // The pill is z-20 and the read-aloud bar z-30, so on a phone —
                // where that bar moved to the bottom — the pill would sit
                // underneath it and the one way back from a footnote jump would
                // be invisible for as long as the book is being read aloud.
                // 62px is the bar's min-height; the pill keeps its own 1rem
                // gutter on top of it. Desktop keeps the bar at the top and is
                // untouched.
                className={`absolute ${
                  isNarrow && readAloudBarOnScreen ? "bottom-[calc(62px+1rem)]" : "bottom-4"
                } left-6 z-20 flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-accent-bg text-accent-text shadow-sm cursor-pointer transition-opacity duration-300 motion-reduce:transition-none hover:opacity-80 ${
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
            {readAloudBarOnScreen && (
                <div
                  // Bottom on a phone: the transport is a thumb control, and at
                  // the top of the page it sat under the reading hand's reach
                  // and over the first line of text. It needs no safe-area
                  // padding down there — the silent strip is a flex sibling
                  // below <main> and already holds that inset open.
                  className={`absolute inset-x-0 z-30 ${isNarrow ? "bottom-0" : "top-0"}`}
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
                    // Under narrow the collapsed capsule's home is the header
                    // cluster, which is not rendered below the breakpoint —
                    // collapsing there would keep the audio playing with no
                    // transport anywhere on screen. So this bar does not offer
                    // it, rather than offering a way out that leads nowhere.
                    onCollapsedChange={isNarrow ? undefined : continuousReadAloud.setCollapsed}
                    placement={isNarrow ? "bottom" : "top"}
                  />
                </div>
              )}
            {!continuousReadAloudActive && <ReadingPlaybackBar />}
          </main>

          {/* Bottom progress bar */}
          <footer
            // The 8px bottom gutter is a floor, not the value. This footer is
            // the last thing on the screen, so on a phone its 8px lands inside
            // the home indicator's 34pt and the progress readout sits under the
            // bar — and because it is a `shrink-0` sibling of <main>, whatever
            // it fails to reserve is room the text above it keeps and then has
            // clipped. `max()` so desktop is untouched: no inset, no change.
            className={`${isNarrow ? "" : "px-page"} pb-[max(0.5rem,var(--spacing-safe-bottom))] pt-0 shrink-0 ${isStandaloneWindow ? "" : "bg-bg-surface"}`}
            style={isStandaloneWindow ? {
              backgroundColor: getThemeStyles(readerSettings.theme, readerSettings.customTheme).body,
              color: getThemeStyles(readerSettings.theme, readerSettings.customTheme).text,
            } : undefined}
          >
            {isNarrow ? (
              // The silent strip: 24pt, one readout, no track. The scrubber and
              // the function keys live in the raised chrome now, so nothing here
              // needs a finger-sized target and the strip can stay this thin.
              //
              // While the read-aloud bar is up the strip keeps its box and drops
              // its contents. Emptying the box instead would change <main>'s
              // height and re-columnize the chapter on every play and stop.
              <div
                className={`flex h-6 items-center justify-start gap-2 text-[12px] tabular-nums ${
                  // The EPUB readout is a button that carries its own px-4 —
                  // its tap target has to reach the edge of the strip even
                  // though its text does not. The static spans (PDF, text
                  // books) are not tappable and would otherwise start at x=0,
                  // touching the bezel. Padding them here rather than there
                  // keeps the two readouts from being padded twice.
                  supportsScrubber
                    ? ""
                    : "pl-[max(var(--spacing-page),var(--spacing-safe-left))] pr-[max(var(--spacing-page),var(--spacing-safe-right))]"
                } ${isStandaloneWindow ? "opacity-60" : "text-text-muted"}`}
              >
                {readAloudBarVisible ? null : progressReadout(true)}
              </div>
            ) : (
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
              {/* The footer's height is set here, not by its contents, so it
                  has to be told about the finger: `Button` grows to 44px under
                  `touch:` and a 32px row would let the PDF zoom controls hang
                  out over the progress track above them. */}
              <div className="flex items-center justify-between h-8 touch:h-11">
                <div className={`flex min-w-0 items-center gap-2 text-[12px] tabular-nums ${isStandaloneWindow ? "opacity-60" : "text-text-muted"}`}>
                  {progressReadout(false)}
                </div>
                {book.format === "pdf" && pdfZoomControls}
                <span className="w-8 touch:w-11" aria-hidden="true" />
              </div>
            </div>
            )}
          </footer>
        </div>

        {/* Not rendered at all below the breakpoint, rather than hidden: a
            full-screen panel has nothing to resize, and a 6px drag strip on a
            touchscreen is a control nobody can hit on purpose and everybody
            hits by accident. `useSidePanelResize` refuses the drag from its
            side too. */}
        {sidePanel && !isNarrow && (
          <div
            onPointerDown={handlePanelResizePointerDown}
            className="w-1 h-full shrink-0 cursor-col-resize touch-none hover:bg-accent/30 transition-colors z-10"
          />
        )}
        <div
          ref={panelRef}
          className={panelShellClass(sidePanel !== null, "", coveringPanel === "ai" || coveringPanel === "traces")}
          // `panelWidth` is undefined below the breakpoint, so no inline width
          // is written and the panel's classes are free to size it. An inline
          // width would beat every one of them.
          style={{ width: panelWidth }}
          onPointerDownCapture={blockPageTurnKeyboard}
        >
          {coveringPanel === "ai" && coveringPanelBar("ai")}
          {coveringPanel === "traces" && coveringPanelBar("traces")}
          {/* No tab bar: X-Ray moved to the traces panel, so the conversation is
              the only thing in here and a one-tab switcher would be a label
              pretending to be a control. The panel gains back its 45px. */}
          <div className={sidePanel === "ai" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
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
                  // A cross-book quote changes the route param but not this
                  // component instance, and the bookId reset effect does not
                  // touch `sidePanel` — so without this the other book opens
                  // underneath a full-screen AI panel, hiding both the passage
                  // and the offer to go back.
                  onNavigateToQuote={(quote) => { closeNarrowPanels(); navigateToQuote(quote); }}
                  onLookupWord={lookupWordInPanel}
                  onSelectText={openPanelSelectionMenu}
                />
              </div>
            </div>
          </div>
          {supportsCfiNavigation && sidePanel === "traces" && bookId && (
            <div className="min-h-0 flex-1">
            <ReaderTracesPanel
              tab={tracesTab}
              onTabChange={setTracesTab}
              vocabProps={{
                bookId,
                bookTitle: book.title,
                onNavigate: (cfi) => {
                  flashNavigationTarget(cfi).catch(() => {});
                  closeNarrowPanels();
                },
                initialWordCfi: activeVocabCfi,
                onWordDetailClosed: () => setActiveVocabCfi(null),
                onExport: () => setExportOpen(true),
              }}
              notesProps={{
                bookId,
                currentCfi: () => currentCfiRef.current,
                onNavigate: (cfi) => {
                  navigateToCfi(cfi);
                  closeNarrowPanels();
                },
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
                // Only a jump that actually landed hands the screen back — a
                // failed one would close the panel and leave the reader looking
                // at the same page with nothing to say why.
                onNavigate: async (source) => {
                  const arrived = await navigateToSource(source) !== false;
                  if (arrived) closeNarrowPanels();
                  return arrived;
                },
                // Sits next to `onNavigate` in the same list and means the same
                // thing to a reader — "take me to that page" — so it hands the
                // screen back the same way.
                onNavigateCurrent: async (location) => {
                  const arrived = await navigateToCurrentXrayOccurrence(location);
                  if (arrived) closeNarrowPanels();
                  return arrived;
                },
              }}
            />
            </div>
          )}
        </div>
      </div>

      {/* The raised chrome.
          Absolutely positioned over the shell rather than expanded into the
          flex column: an in-flow bar would change <main>'s height and make
          foliate re-columnize the chapter every time the reader tapped the
          middle of the page.
          z-30 puts it over the page and under the covering panels (z-50), so a
          panel opened from the function row simply covers it instead of having
          to be sequenced against it. Clicks stop here so they do not reach the
          viewport handler that clears the reader's selection. */}
      {isNarrow && chromeOpen && (
        <>
          <div
            className={`absolute inset-x-0 top-0 z-30 shadow-popover ${TOP_INSET} ${isStandaloneWindow ? "" : "bg-bg-surface border-b border-border"}`}
            style={chromeSurfaceStyle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex h-12 items-center gap-1 px-1">
              {/* Same swap as the silent strip above: a standalone window has
                  no library to go back to, and routing it to "/" would strand
                  the one book it exists to hold. */}
              {isStandaloneWindow ? (
                <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent">
                  <BookOpen size={18} className="text-white" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  aria-label={t("reader.returnToLibrary")}
                  className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-text-muted"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              {/* Two lines here, one in the silent strip: the strip has 40pt and
                  says where you are; the raised bar has room to also say what
                  you are in, which is the question a reader who just opened the
                  controls is most likely asking. */}
              <div className="flex min-w-0 flex-1 flex-col items-center">
                <span className="w-full truncate text-center text-[14px] font-semibold leading-5 text-text-primary">
                  {book.title}
                </span>
                <span className="w-full truncate text-center text-[12px] leading-4 text-text-muted">
                  {narrowLocationLabel}
                </span>
              </div>
              <button
                type="button"
                onClick={() => { setChromeOpen(false); toggleAiPanel(); }}
                aria-label={t("reader.aiAssistant")}
                className={`grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg ${
                  sidePanel === "ai" ? "text-accent-text" : "text-text-muted"
                }`}
              >
                <Sparkles size={18} />
              </button>
            </div>
          </div>

          <div
            className={`absolute inset-x-0 bottom-0 z-30 shadow-popover pb-[max(0.5rem,var(--spacing-safe-bottom))] ${isStandaloneWindow ? "" : "bg-bg-surface border-t border-border"}`}
            style={chromeSurfaceStyle}
            onClick={(event) => event.stopPropagation()}
          >
            {/* The scrubber is unconditional here, unlike the desktop footer's
                copy: `showChapterProgress` decides whether a *silent* strip
                shows a progress line, and a reader who has deliberately raised
                the controls is asking to move through the book. */}
            {supportsScrubber && (
              <div className="px-page pt-3">
                <ProgressScrubber
                  progress={progress}
                  ticks={scrubberTicks}
                  isStandaloneWindow={isStandaloneWindow}
                  onCommit={handleScrubberCommit}
                />
              </div>
            )}
            {/* Zoom is absolutely placed so the readout stays centred on the
                bar's midline whether or not the book is a PDF — the readout is
                the same control as the one in the silent strip, and it should
                not move when the chrome comes up. */}
            <div className={`relative flex min-h-11 items-center justify-center gap-2 px-page text-[12px] tabular-nums ${isStandaloneWindow ? "opacity-60" : "text-text-muted"}`}>
              {progressReadout(false)}
              {book.format === "pdf" && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2">{pdfZoomControls}</div>
              )}
            </div>
            <div className="flex items-stretch gap-1 px-1 pb-1">
              {chromeActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    type="button"
                    disabled={action.disabled}
                    aria-disabled={action.disabled || undefined}
                    title={action.label}
                    onClick={() => { setChromeOpen(false); action.run(); }}
                    className={`flex min-h-13 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg disabled:cursor-default disabled:opacity-35 ${
                      action.active ? "text-accent-text" : "text-text-muted"
                    }`}
                  >
                    <Icon size={20} />
                    <span className="max-w-full truncate text-[10px] leading-3">{action.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* The one-time tap-zone guide, over everything including the raised
          bars (it portals to <body>). */}
      {shouldShowZoneGuide({
        narrow: isNarrow,
        readingMode: readerSettings.readingMode,
        bookReady,
        shownFlag: zoneGuideShownFlag,
      }) && (
        <ReaderZoneGuide oneHand={oneHandMode} onDismiss={dismissZoneGuide} />
      )}

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
          // Only a single click on a word can end as a glance. A word reached
          // by dragging a selection gets the same card, but the gesture no
          // longer says "I stopped on this word" — and under-counting is the
          // side to err on for something that costs mastery.
          onGlance={bookId && contextMenu.trigger === "word-menu"
            ? (definition) => handleDictionaryGlance(contextMenu, definition)
            : undefined}
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
          getTextRect={getReaderPageRect}
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
