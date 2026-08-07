import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ReaderSettingsState } from "../../components/ReaderSettings";
import {
  getEffectivePageColumns,
  getReaderCapabilities,
  getReaderMeasure,
  getThemeStyles,
  type ReaderCapabilities,
} from "../../components/reader-settings";
import {
  classifySelection,
  contextForRange,
  normalizeInteractionText,
  type ReaderInteraction,
} from "../../components/reader-interaction";
import { installCustomFontFacesInDocument } from "../../components/custom-fonts";
import { installBuiltinFontFacesInDocument } from "../../components/builtin-fonts";
import { expandWordForms } from "../../components/word-forms";
import { isNarrowPassiveVocabViewport } from "../../components/passive-vocab";
import type { Highlight } from "../../hooks/useBookmarks";
import type { Book } from "../../hooks/useBooks";
import { logIgnoredError } from "../../utils/logIgnoredError";
import { loadFoliateModules } from "./foliate-modules";
import { disposeFoliateViewAfterInitialization } from "./foliate-view-lifecycle";
import {
  logReaderDiagnostic,
  readerEnvironmentSnapshot,
  recordReflowTiming,
  setDiagnosticContext,
} from "../../utils/readerDiagnostics";
import { createChapterPaginationMarker } from "./chapter-pagination";
import {
  applyPdfLayout,
  applyReflowLayout,
  getFootnoteCSS,
  getReaderCSS,
} from "./reader-theme";
import { movedDuringReflow } from "./reader-reflow-anchor";
import {
  FOOTNOTE_CONTENT_WIDTH,
  FOOTNOTE_POPOVER_MAX_HEIGHT,
  FOOTNOTE_POPOVER_MIN_HEIGHT,
  type FootnotePopoverData,
} from "../../components/FootnotePopover";
import {
  drawFoliateAnnotation,
  type FoliateMarker,
  type WordMarkException,
  type WordMarkRule,
} from "./useFoliateAnnotations";
import type {
  FoliateTocItem,
  FoliateView,
  ReaderPageInfo,
  TocChapter,
} from "./foliate-types";
import { readerOpenKey } from "./reader-open-key";
import { toReaderOpenError, type ReaderOpenError } from "./reader-open-error";
import {
  markTypographyDropCapParagraphs,
  markTypographyIndentExceptions,
  markTypographyMediaParagraphs,
} from "./reader-typography";
import type { SidePanel, TracesTab } from "./side-panel";

function getPdfStartCfi(
  progress: number,
  pageCount: number | null | undefined,
): string | undefined {
  if (!Number.isFinite(progress) || progress <= 0 || !pageCount || pageCount <= 0) return undefined;
  const index = Math.min(
    pageCount - 1,
    Math.max(0, Math.ceil((progress / 100) * pageCount) - 1),
  );
  return `epubcfi(/6/${(index + 1) * 2})`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface FootnoteLinkEventDetail {
  a: HTMLAnchorElement;
  href: string;
}

interface FootnoteRenderEventDetail {
  view: FoliateView;
  href: string;
  type: string | null;
  hidden: boolean;
  target: Element | null;
}

interface FootnoteHandlerLike extends EventTarget {
  detectFootnotes: boolean;
  // Returns undefined when `a` isn't a footnote reference (default link
  // navigation proceeds as usual). Otherwise it has already called
  // event.preventDefault() and returns a promise that resolves once the
  // nested view's 'render' event has fired.
  handle(
    book: unknown,
    event: CustomEvent<FootnoteLinkEventDetail>,
  ): Promise<void> | undefined;
}

// footnotes.js ships alongside view.js in public/foliate-js (see its
// LANTERN.md), so it comes in through the module bridge rather than a direct
// dynamic import — see `loadFoliateModules`.
function loadFootnoteHandlerCtor(): Promise<new () => FootnoteHandlerLike> {
  return loadFoliateModules()
    .then((modules) => modules.FootnoteHandler as new () => FootnoteHandlerLike);
}

// Tracks the click that is currently waiting on the FootnoteHandler's
// 'before-render'/'render' events, which fire on a single shared handler
// instance rather than per-request. `token` lets a stale pair — from a click
// the user has already superseded by clicking another reference — recognize
// itself and discard its nested view instead of popping up late.
interface PendingFootnote {
  token: number;
  x: number;
  y: number;
  marker: string;
  href: string;
  nestedView: FoliateView | null;
}

interface InstallDocumentInteractionsOptions {
  doc: Document;
  index: number;
  view: FoliateView;
  bookFormat: string;
  interactionGeneration: number;
}

interface UseFoliateViewOptions {
  book: Book | null;
  bookId?: string;
  bookReady: boolean;
  isTextBook: boolean;
  readerRetry: number;
  /**
   * False until this book's settings have been read from the DB. The open
   * sequence bakes in reader settings (PDF scroll mode picks the renderer,
   * font size sizes the first columnize pass), so opening before they land
   * meant opening twice — once with defaults, once for real.
   */
  settingsReady: boolean;
  readerSettings: ReaderSettingsState;
  readerSettingsRef: MutableRefObject<ReaderSettingsState>;
  initialCapabilities: ReaderCapabilities;
  capabilities: ReaderCapabilities;
  onRenditionLayout(layout: string | undefined): void;
  viewRef: MutableRefObject<FoliateView | null>;
  viewerRef: MutableRefObject<HTMLDivElement | null>;
  currentCfiRef: MutableRefObject<string | null>;
  chaptersRef: MutableRefObject<TocChapter[]>;
  readerInteractionGenerationRef: MutableRefObject<number>;
  pendingWordClickRef: MutableRefObject<number | null>;
  annotationClickDocumentRef: MutableRefObject<Document | null>;
  contextMenuRequestRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number | "fit">;
  fitPctRef: MutableRefObject<number>;
  markerStyleRef: MutableRefObject<Parameters<typeof drawFoliateAnnotation>[1]>;
  wordMarkWordsRef: MutableRefObject<string[]>;
  wordMarkExceptionsRef: MutableRefObject<Set<string>>;
  autoMarkersRef: MutableRefObject<Map<string, FoliateMarker>>;
  applyAnnotations(reapplyVisible?: boolean): Promise<void>;
  applyPassiveVocabAnnotations(loaded?: { doc: Document; index: number }): void;
  applyFoliateMarkerStyles(): void;
  installDocumentInteractions(options: InstallDocumentInteractionsOptions): void;
  queueReadingProgress(bookId: string, progress: number, cfi: string): void;
  cancelPendingWordClick(): void;
  cancelPendingSelectionMenu(): void;
  openLearningInteraction(interaction: ReaderInteraction): void;
  setBookReady: Dispatch<SetStateAction<boolean>>;
  setReaderError: Dispatch<SetStateAction<ReaderOpenError | null>>;
  /** Jump-history push/fade hooks (P1.3) — see `useJumpHistory`. */
  pushJump: (location: string | null | undefined, label: string) => void;
  getCurrentLabel: () => string;
  notifyLocationChanged: () => void;
  setChapters: Dispatch<SetStateAction<TocChapter[]>>;
  setCurrentChapterIndex: Dispatch<SetStateAction<number>>;
  setCurrentSectionIndex: Dispatch<SetStateAction<number>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setChapterProgress: Dispatch<SetStateAction<number>>;
  setPageInfo: Dispatch<SetStateAction<ReaderPageInfo | null>>;
  setActiveVocabCfi: Dispatch<SetStateAction<string | null>>;
  setTracesTab: Dispatch<SetStateAction<TracesTab>>;
  setSidePanel: Dispatch<SetStateAction<SidePanel>>;
  setContextMenu: Dispatch<SetStateAction<ReaderInteraction | null>>;
  setFootnote: Dispatch<SetStateAction<FootnotePopoverData | null>>;
}

function flattenToc(items: unknown[], depth = 0): TocChapter[] {
  const tocHref = (item: Record<string, unknown>): string | undefined => (
    typeof item.href === "string" && item.href !== "" && item.href !== "null"
      ? item.href
      : undefined
  );
  const firstHref = (item: Record<string, unknown>): string | undefined => {
    const href = tocHref(item);
    if (href) return href;
    return Array.isArray(item.subitems)
      ? item.subitems
        .map((child) => firstHref(child as Record<string, unknown>))
        .find((value): value is string => Boolean(value))
      : undefined;
  };
  return items.flatMap((value) => {
    const item = value as Record<string, unknown>;
    const label = item.label;
    return [
      {
        title: typeof label === "string" ? label.trim() : "",
        href: tocHref(item),
        targetHref: firstHref(item),
        depth,
        // `TOCProgress.assignIDs()` (progress.js) stamps this onto `book.toc` during `view.open()`.
        id: typeof item.id === "number" ? item.id : undefined,
      },
      ...(Array.isArray(item.subitems) ? flattenToc(item.subitems, depth + 1) : []),
    ];
  });
}

/**
 * Matches the engine's reported current TOC item (from the `relocate` event,
 * or `getTOCItemOf`) against the flattened chapter list. Prefers the stable
 * `id` foliate-js assigns to every TOC node (`assignIDs()` in progress.js),
 * falling back to href matching for formats or engine versions where no id
 * is available.
 */
function findCurrentChapterIndex(
  chapters: TocChapter[],
  tocItem: FoliateTocItem | undefined,
): number {
  if (!tocItem) return -1;
  if (typeof tocItem.id === "number") {
    const byId = chapters.findIndex((chapter) => chapter.id === tocItem.id);
    if (byId !== -1) return byId;
  }
  const byHref = chapters.findIndex((chapter) => chapter.href === tocItem.href);
  if (byHref !== -1) return byHref;
  return chapters.findIndex((chapter) => chapter.targetHref === tocItem.href);
}

async function resolveTocSectionIndex(
  book: { resolveHref?: (href: string) => unknown | Promise<unknown> },
  href?: string,
): Promise<number | undefined> {
  if (!href || typeof book.resolveHref !== "function") return undefined;
  try {
    const target = await withTimeout(
      Promise.resolve(book.resolveHref(href)),
      1_500,
      "READER_TOC_RANGE_TIMEOUT",
    );
    const index = target && typeof target === "object"
      ? (target as { index?: unknown }).index
      : undefined;
    return typeof index === "number" && Number.isInteger(index) && index >= 0
      ? index
      : undefined;
  } catch {
    return undefined;
  }
}

export function useFoliateView({
  book,
  bookId,
  bookReady,
  isTextBook,
  readerRetry,
  settingsReady,
  readerSettings,
  readerSettingsRef,
  initialCapabilities,
  capabilities,
  onRenditionLayout,
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
}: UseFoliateViewOptions) {
  const loadedInteractionDocumentsRef = useRef(new WeakSet<Document>());
  const footnoteRequestRef = useRef(0);
  const applyFoliateMarkerStylesRef = useRef(applyFoliateMarkerStyles);
  const applyPassiveVocabAnnotationsRef = useRef(applyPassiveVocabAnnotations);
  useEffect(() => {
    applyFoliateMarkerStylesRef.current = applyFoliateMarkerStyles;
  }, [applyFoliateMarkerStyles]);
  useEffect(() => {
    applyPassiveVocabAnnotationsRef.current = applyPassiveVocabAnnotations;
  }, [applyPassiveVocabAnnotations]);
  // The rest of the callbacks the opened view calls back into. All of them are
  // invoked from foliate event listeners or from post-open code, never during
  // the open itself, so a ref is enough — and it keeps their identity out of
  // the open effect's dependencies, where it used to force a full re-open.
  const applyAnnotationsRef = useRef(applyAnnotations);
  const installDocumentInteractionsRef = useRef(installDocumentInteractions);
  const queueReadingProgressRef = useRef(queueReadingProgress);
  const onRenditionLayoutRef = useRef(onRenditionLayout);
  useEffect(() => {
    applyAnnotationsRef.current = applyAnnotations;
    installDocumentInteractionsRef.current = installDocumentInteractions;
    queueReadingProgressRef.current = queueReadingProgress;
    onRenditionLayoutRef.current = onRenditionLayout;
  }, [applyAnnotations, installDocumentInteractions, onRenditionLayout, queueReadingProgress]);
  // Size the reader stylesheet was last written with. Tracked because the
  // narrow-viewport shrink can change it on resize alone.
  const appliedFontSizeRef = useRef(readerSettings.fontSize);
  // Which passive-vocab presentation the loaded documents were installed with.
  const appliedNarrowViewportRef = useRef(
    isNarrowPassiveVocabViewport(typeof window === "undefined" ? 0 : window.innerWidth),
  );
  const pdfReadingMode = book?.format === "pdf" ? readerSettings.readingMode : null;

  // The effect's one and only dependency — see `readerOpenKey` for why.
  const openKey = readerOpenKey({
    book,
    isTextBook,
    settingsReady,
    pdfReadingMode,
    readerRetry,
  });

  useEffect(() => {
    if (!openKey || !book || !viewerRef.current) return;

    const interactionGeneration = ++readerInteractionGenerationRef.current;
    const container = viewerRef.current;
    container.innerHTML = "";
    loadedInteractionDocumentsRef.current = new WeakSet<Document>();
    setBookReady(false);
    // A retry recreates Foliate without changing the book id. Clear the
    // previous section until the new view emits its first relocate event.
    setCurrentSectionIndex(-1);
    setReaderError(null);
    let cancelled = false;
    // Drops the in-flight transfer the moment this open is superseded, rather
    // than letting a whole book file finish downloading for a view nobody will
    // ever see.
    const fetchAbort = new AbortController();
    let activeView: FoliateView | null = null;
    let firstSectionLogged = false;
    let footnoteStagingHost: HTMLDivElement | null = null;
    let openedCapabilities = initialCapabilities;

    const initFoliate = async () => {
      logReaderDiagnostic(
        "reader.open.start",
        `format=${book.format} render=${book.render_format ?? "-"}`,
      );
      logReaderDiagnostic("reader.env", JSON.stringify(readerEnvironmentSnapshot()));
      if (openedCapabilities.supportsWordMarkers && bookId) {
        const [rules, exceptions] = await Promise.all([
          invoke<WordMarkRule[]>("list_word_marks", { bookId }).catch((error) => {
            logIgnoredError("reader.load-word-marks", error);
            return [];
          }),
          invoke<WordMarkException[]>("list_word_mark_exceptions", { bookId }).catch((error) => {
            logIgnoredError("reader.load-word-mark-exceptions", error);
            return [];
          }),
        ]);
        const ruleWords = rules
          .filter((rule) => rule.enabled)
          .map((rule) => rule.normalized_word);
        wordMarkWordsRef.current = await expandWordForms(
          ruleWords,
          markerStyleRef.current.wordMatchScope === "forms",
        );
        wordMarkExceptionsRef.current = new Set(exceptions
          .filter((exception) => exception.excluded)
          .map((exception) => `${exception.normalized_word}\0${exception.location}`));
      } else {
        wordMarkWordsRef.current = [];
        wordMarkExceptionsRef.current.clear();
      }

      if (!customElements.get("foliate-view")) {
        logReaderDiagnostic("reader.open.script-load-start");
        await withTimeout(new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.type = "module";
          script.src = "/foliate-js/view.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load foliate-js"));
          document.head.appendChild(script);
        }), 15_000, "READER_SCRIPT_TIMEOUT");
        await withTimeout(
          customElements.whenDefined("foliate-view"),
          15_000,
          "READER_ELEMENT_TIMEOUT",
        );
        logReaderDiagnostic("reader.open.script-loaded");
      }
      if (cancelled) return;

      // A footnote handler that won't load costs the popover, not the book:
      // link clicks fall through to the ordinary in-book jump below, which is
      // what they did before footnote support existed.
      let FootnoteHandlerCtor: (new () => FootnoteHandlerLike) | null = null;
      try {
        FootnoteHandlerCtor = await loadFootnoteHandlerCtor();
      } catch (error) {
        logReaderDiagnostic("reader.open.footnotes-unavailable");
        logIgnoredError("reader.footnote-handler-load", error);
      }
      if (cancelled) return;
      const footnoteHandler: FootnoteHandlerLike | null = FootnoteHandlerCtor
        ? new FootnoteHandlerCtor()
        : null;
      // Kept permanently off-screen (not just unmounted) rather than created
      // per-click: FootnoteHandler renders into it before React ever sees the
      // click, and Foliate's paginator needs a connected element with real
      // dimensions to lay out against at that point. FootnotePopover moves
      // the finished nested view out of here and into the visible bubble.
      footnoteStagingHost = document.createElement("div");
      footnoteStagingHost.style.cssText = "position:fixed; top:0; left:-99999px; "
        + `width:${FOOTNOTE_CONTENT_WIDTH}px; height:${FOOTNOTE_POPOVER_MAX_HEIGHT}px; `
        + "overflow:hidden; visibility:hidden; pointer-events:none;";
      document.body.appendChild(footnoteStagingHost);
      const stagingHost = footnoteStagingHost;

      let pendingFootnote: PendingFootnote | null = null;

      footnoteHandler?.addEventListener("before-render", ((event: CustomEvent<{ view: FoliateView }>) => {
        if (cancelled || !pendingFootnote) return;
        const nestedView = event.detail.view;
        pendingFootnote.nestedView = nestedView;
        nestedView.style.display = "block";
        nestedView.style.width = `${FOOTNOTE_CONTENT_WIDTH}px`;
        nestedView.style.height = `${FOOTNOTE_POPOVER_MAX_HEIGHT}px`;
        stagingHost.appendChild(nestedView);
        // `view.open(book)` (awaited inside FootnoteHandler just before this
        // event) has already resolved, so the renderer exists and is fully
        // opened — safe to configure before goTo() loads the fragment into it.
        // Non-rendering attributes first, `flow` last, so only one reflow
        // happens (mirrors applyReflowLayout's ordering, see reader-theme.ts).
        nestedView.renderer?.setAttribute("gap", "0%");
        nestedView.renderer?.setAttribute("margin", "0%");
        nestedView.renderer?.setStyles?.(getFootnoteCSS(readerSettingsRef.current));
        nestedView.renderer?.setAttribute("flow", "scrolled");
      }) as EventListener);

      footnoteHandler?.addEventListener("render", ((event: CustomEvent<FootnoteRenderEventDetail>) => {
        const { view: nestedView, hidden, target } = event.detail;
        if (!pendingFootnote || pendingFootnote.nestedView !== nestedView) return;
        const current = pendingFootnote;
        pendingFootnote = null;
        if (cancelled) {
          nestedView.remove();
          return;
        }
        // Publishers commonly author footnote asides with an HTML `hidden`
        // attribute so they render only as a popup and never inline — Foliate
        // flags that case here but doesn't clear it, so nothing would show.
        if (hidden) (target as HTMLElement | null)?.removeAttribute?.("hidden");
        const contents = (nestedView.renderer?.getContents?.() ?? []) as Array<{ doc?: Document }>;
        const doc = contents[0]?.doc;
        const measured = doc ? Math.ceil(doc.documentElement.getBoundingClientRect().height) : 0;
        const height = Math.min(
          FOOTNOTE_POPOVER_MAX_HEIGHT,
          Math.max(FOOTNOTE_POPOVER_MIN_HEIGHT, measured || FOOTNOTE_POPOVER_MIN_HEIGHT),
        );
        nestedView.style.height = `${height}px`;
        if (footnoteRequestRef.current !== current.token) {
          // Superseded by a later click before this one finished rendering.
          nestedView.remove();
          return;
        }
        setFootnote({
          x: current.x,
          y: current.y,
          marker: current.marker,
          href: current.href,
          contentHost: nestedView,
          contentHeight: height,
        });
      }) as EventListener);

      const view = document.createElement("foliate-view") as FoliateView;
      activeView = view;
      view.style.display = "block";
      view.style.width = "100%";
      view.style.height = "100%";
      if (book.format === "pdf" && readerSettings.readingMode === "scrolling") {
        view.setAttribute("pdf-mode", "scroll");
      }
      container.appendChild(view);
      viewRef.current = view;

      logReaderDiagnostic("reader.open.fetch-start");
      const response = await withTimeout(
        fetch(convertFileSrc(book.file_path), { signal: fetchAbort.signal }),
        30_000,
        "READER_FILE_TIMEOUT",
      );
      logReaderDiagnostic("reader.open.fetch-done", `status=${response.status}`);
      // Superseded while the file was on the wire. Everything past here is the
      // expensive half of the open — reading the body and handing it to
      // foliate's `makeBook` — and it is exactly the half that used to run
      // concurrently with the replacement open and race it.
      if (cancelled) {
        logReaderDiagnostic("reader.open.superseded", "at=fetch-done");
        return;
      }
      if (!response.ok) throw new Error(`READER_FILE_${response.status}`);
      const extension = (book.render_format || book.format || "epub").toLowerCase();
      const mime = {
        epub: "application/epub+zip",
        pdf: "application/pdf",
        mobi: "application/x-mobipocket-ebook",
        azw: "application/x-mobipocket-ebook",
        azw3: "application/x-mobipocket-ebook",
        fb2: "application/x-fictionbook+xml",
        fbz: "application/x-zip-compressed-fb2",
        cbz: "application/vnd.comicbook+zip",
      }[extension] || "application/octet-stream";
      const file = new File(
        [await withTimeout(response.blob(), 30_000, "READER_FILE_READ_TIMEOUT")],
        `book.${extension}`,
        { type: mime },
      );
      if (cancelled) {
        logReaderDiagnostic("reader.open.superseded", "at=file-read");
        return;
      }
      logReaderDiagnostic("reader.open.view-open-start", `bytes=${file.size} mime=${mime}`);
      await withTimeout(view.open(file), 45_000, "READER_OPEN_TIMEOUT");
      if (cancelled) return;
      logReaderDiagnostic("reader.open.view-open-done");
      const renditionLayout = typeof view.book?.rendition?.layout === "string"
        ? view.book.rendition.layout
        : undefined;
      openedCapabilities = getReaderCapabilities(extension, renditionLayout);
      onRenditionLayoutRef.current(renditionLayout);

      // This was the one await in the open flow with no timeout: it eagerly
      // resolves every TOC href, and on Safari 15.1 a section resolve can hang
      // forever (foliate swallows the underlying error), wedging the reader on
      // "Preparing book…" with no error surfaced. Guard it, and degrade to no
      // chapter-start markers rather than failing the whole open — reading
      // works without them, and the timeout gives us a diagnostic anchor.
      logReaderDiagnostic("reader.open.chapter-marker-start");
      let markChapterStarts: (doc: Document, index: number) => number;
      try {
        markChapterStarts = await withTimeout(
          createChapterPaginationMarker(view.book, (done, total) => {
            // Frozen at the hang point, `done/total` says how many chapters
            // resolved before a section wedged — the key "Preparing" signal.
            setDiagnosticContext("chapter.resolve", `${done}/${total}`);
          }),
          20_000,
          "READER_CHAPTER_MARKER_TIMEOUT",
        );
        logReaderDiagnostic("reader.open.chapter-marker-done");
      } catch (error) {
        logReaderDiagnostic("reader.open.chapter-marker-timeout", error);
        markChapterStarts = () => 0;
      }
      if (cancelled) return;
      if (openedCapabilities.supportsReflowSettings) {
        appliedFontSizeRef.current = applyReflowLayout(
          view,
          readerSettings,
          container.clientWidth,
          container.clientHeight,
        ).fontSize;
      } else if (openedCapabilities.supportsSpread) {
        if (book.format === "pdf") {
          applyPdfLayout(view, readerSettings, container.clientWidth, container.clientHeight);
        } else {
          view.renderer.setAttribute("max-column-count", String(readerSettings.pageColumns));
        }
      }
      if (openedCapabilities.supportsZoom && book.format === "pdf") {
        const savedZoom = localStorage.getItem(`reader-zoom-${bookId}`);
        let zoomAttr = "fit-width";
        if (savedZoom && savedZoom !== "fit") {
          const value = parseInt(savedZoom, 10);
          if (Number.isFinite(value) && value >= 50 && value <= 300) {
            zoomAttr = String(value / 100);
          }
        }
        view.renderer.setAttribute("zoom", zoomAttr);
      }
      if (openedCapabilities.supportsReflowSettings) {
        view.renderer.setStyles?.(getReaderCSS(readerSettings, appliedFontSizeRef.current));
      }

      if (Array.isArray(view.book.toc)) {
        const chapters = flattenToc(view.book.toc);
        chaptersRef.current = chapters;
        setChapters(chapters);
        // Keep the UI's flattened TOC, but enrich it with raw section starts
        // so the AI planner can expand a logical reading unit beyond the
        // single XHTML/page currently visible in Foliate.
        void Promise.all(chapters.map(async (chapter) => ({
          ...chapter,
          sectionIndex: await resolveTocSectionIndex(
            view.book,
            chapter.targetHref ?? chapter.href,
          ),
          sectionFragment: (chapter.targetHref ?? chapter.href)?.split("#")[1] || undefined,
        }))).then((resolved) => {
          if (cancelled) return;
          chaptersRef.current = resolved;
          setChapters(resolved);
        });
      }

      view.addEventListener("relocate", ((event: CustomEvent) => {
        const { fraction, section, cfi } = event.detail;
        const tocItem = event.detail.tocItem as FoliateTocItem | undefined;
        const nextProgress = Math.round((fraction ?? 0) * 100);
        setProgress(nextProgress);
        const sectionIndex = typeof section?.current === "number" ? section.current : -1;
        if (sectionIndex >= 0) setCurrentSectionIndex(sectionIndex);
        const sectionFractions = view.getSectionFractions?.() ?? [];
        const sectionStart = sectionFractions[sectionIndex];
        const sectionEnd = sectionFractions[sectionIndex + 1];
        const sectionProgress = Number.isFinite(sectionStart)
          && Number.isFinite(sectionEnd)
          && sectionEnd > sectionStart
          ? ((fraction ?? sectionStart) - sectionStart) / (sectionEnd - sectionStart)
          : 0;
        setChapterProgress(Math.round(Math.max(0, Math.min(1, sectionProgress)) * 100));
        currentCfiRef.current = cfi;

        const activeSettings = readerSettingsRef.current;
        if (openedCapabilities.supportsReflowSettings && activeSettings.readingMode === "paginated") {
          const current = Number(view.renderer?.page);
          // `view.renderer.pages` is foliate's *current-chapter* page count —
          // it is rebuilt by the paginator on every chapter load, so it is
          // only ever "how many screens the chapter now open takes", never
          // the whole book. Fine for the page-number readout below, which is
          // explicitly chapter-scoped (see `useProgressReadout.ts`'s
          // in-chapter remaining-pages math for the same convention). Wrong
          // as a §2.2 auto-finish denominator, which used to be sourced from
          // this same value — see
          // `reading_behavior::estimate_total_book_screens` on the backend
          // for where that denominator comes from now.
          const total = Math.max(1, Number(view.renderer?.pages) - 2);
          setPageInfo(Number.isFinite(current) && Number.isFinite(total) ? {
            current: Math.max(1, Math.min(total, current)),
            total,
          } : null);
        } else if (book.format === "pdf" && sectionIndex >= 0 && section?.total > 0) {
          const current = sectionIndex + 1;
          const effectiveColumns = getEffectivePageColumns(
            activeSettings,
            container.clientWidth,
            container.clientHeight,
          );
          setPageInfo({
            current,
            visibleEnd: effectiveColumns === 2
              ? Math.min(section.total, current + 1)
              : current,
            total: section.total,
          });
        } else {
          setPageInfo(null);
        }
        // `tocItem` here is the same `TOCProgress.getProgress()` result `getTOCItemOf()` would
        // return, delivered for free on every relocate — no need to call the engine method
        // itself, which re-parses the section document.
        const chapterIndex = findCurrentChapterIndex(chaptersRef.current, tocItem);
        if (chapterIndex !== -1) setCurrentChapterIndex(chapterIndex);
        if (bookId && cfi) queueReadingProgressRef.current(bookId, nextProgress, cfi);
        // Fires for both jumps and ordinary page turns — the return pill's
        // fade counter (P1.3) only needs to know a location changed, not why.
        notifyLocationChanged();
      }) as EventListener);

      // FootnoteHandler.handle() calls event.preventDefault() itself, and
      // only when it recognizes `a` as a footnote/biblioref/glossref
      // reference (by epub:type, role, or the "superscript near a backlink"
      // heuristic) — every other internal link is untouched and falls
      // through to Foliate's own default #handleLinks jump, exactly as today.
      view.addEventListener("link", ((event: CustomEvent<FootnoteLinkEventDetail>) => {
        const handled = footnoteHandler?.handle(view.book, event);
        if (!handled) {
          // Not a footnote — an ordinary in-book cross-reference link, which
          // Foliate now sends on to its own default `goTo`. That's a real
          // jump away from here, so push before it lands (P1.3).
          pushJump(currentCfiRef.current, getCurrentLabel());
          return;
        }
        const { a, href } = event.detail;
        const rect = a.getBoundingClientRect();
        const frame = a.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
        const frameRect = frame?.getBoundingClientRect();
        const token = ++footnoteRequestRef.current;
        pendingFootnote = {
          token,
          x: rect.left + (frameRect?.left ?? 0),
          y: rect.bottom + (frameRect?.top ?? 0) + 6,
          marker: a.textContent?.trim() ?? "",
          href,
          nestedView: null,
        };
        setFootnote(null);
        handled.catch((error) => {
          logIgnoredError("reader.footnote-render-failed", error);
          if (cancelled || footnoteRequestRef.current !== token) return;
          pendingFootnote = null;
          // The popover itself failed to render, so this falls back to an
          // actual navigation (same as the popover's own "jump to source") —
          // push before it, same as any other jump.
          pushJump(currentCfiRef.current, getCurrentLabel());
          view.goTo(href).catch(() => {});
        });
      }) as EventListener);

      view.addEventListener("load", ((event: CustomEvent) => {
        const { doc, index } = event.detail as { doc: Document; index: number };
        if (!firstSectionLogged) {
          firstSectionLogged = true;
          logReaderDiagnostic("reader.open.first-section-loaded", `index=${index}`);
        }
        markChapterStarts(doc, index);
        markTypographyMediaParagraphs(doc);
        markTypographyIndentExceptions(doc);
        markTypographyDropCapParagraphs(doc);
        installBuiltinFontFacesInDocument(doc);
        installCustomFontFacesInDocument(doc);
        if (loadedInteractionDocumentsRef.current.has(doc)) return;
        loadedInteractionDocumentsRef.current.add(doc);
        window.requestAnimationFrame(() => {
          applyFoliateMarkerStylesRef.current();
          applyPassiveVocabAnnotationsRef.current({ doc, index });
        });
        installDocumentInteractionsRef.current({
          doc,
          index,
          view,
          bookFormat: book.format,
          interactionGeneration,
        });
      }) as EventListener);

      view.addEventListener("create-overlay", (() => {
        if (bookId && openedCapabilities.supportsManualAnnotations) {
          applyAnnotationsRef.current(true).catch(() => {});
        }
      }) as EventListener);
      view.addEventListener("draw-annotation", ((event: CustomEvent) => {
        drawFoliateAnnotation(
          event.detail,
          markerStyleRef.current,
          book.format === "pdf",
          () => {
            const { theme, customTheme } = readerSettingsRef.current;
            return getThemeStyles(theme, customTheme).body;
          },
        );
      }) as EventListener);
      view.addEventListener("show-annotation", ((event: CustomEvent) => {
        cancelPendingWordClick();
        const { value, range } = event.detail;
        const ownerDocument = range?.startContainer?.ownerDocument ?? null;
        annotationClickDocumentRef.current = ownerDocument;
        queueMicrotask(() => {
          if (annotationClickDocumentRef.current === ownerDocument) {
            annotationClickDocumentRef.current = null;
          }
        });
        const marker = autoMarkersRef.current.get(value);
        if (marker?.kind === "vocab") {
          setActiveVocabCfi(value);
          setTracesTab("vocab");
          setSidePanel("traces");
          return;
        }
        if (marker?.kind === "lookup" && range) {
          const rect = range.getBoundingClientRect();
          const iframe = range.startContainer?.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
          const iframeRect = iframe?.getBoundingClientRect();
          const text = range.toString().trim();
          if (!text) return;
          openLearningInteraction({
            trigger: "selection-menu",
            kind: "word",
            text,
            normalizedText: normalizeInteractionText(text),
            context: contextForRange(range, text),
            location: value,
            anchorRect: {
              left: rect.left + (iframeRect?.left ?? 0),
              top: rect.top + (iframeRect?.top ?? 0),
              right: rect.right + (iframeRect?.left ?? 0),
              bottom: rect.bottom + (iframeRect?.top ?? 0),
              width: rect.width,
              height: rect.height,
            },
            source: "foliate",
            format: book.format === "pdf" ? "pdf" : "epub",
            locale: range.startContainer.ownerDocument?.documentElement.lang || undefined,
          });
          return;
        }
        if (bookId && range) {
          const requestToken = ++contextMenuRequestRef.current;
          setContextMenu(null);
          pendingWordClickRef.current = window.setTimeout(() => {
            pendingWordClickRef.current = null;
            invoke<Highlight[]>("list_highlights", { bookId }).then((highlights) => {
              if (contextMenuRequestRef.current !== requestToken) return;
              const highlight = highlights.find((item) => item.cfi_range === value);
              if (!highlight) return;
              const rect = range.getBoundingClientRect();
              const iframe = range.startContainer?.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
              const iframeRect = iframe?.getBoundingClientRect();
              const text = highlight.text_content?.trim() || range.toString().trim();
              if (!text || contextMenuRequestRef.current !== requestToken) return;
              openLearningInteraction({
                trigger: "selection-menu",
                kind: classifySelection(
                  text,
                  range.startContainer.ownerDocument?.documentElement.lang || undefined,
                ),
                text,
                normalizedText: normalizeInteractionText(text),
                context: contextForRange(range, text),
                location: highlight.cfi_range,
                anchorRect: {
                  left: rect.left + (iframeRect?.left ?? 0),
                  top: rect.top + (iframeRect?.top ?? 0),
                  right: rect.right + (iframeRect?.left ?? 0),
                  bottom: rect.bottom + (iframeRect?.top ?? 0),
                  width: rect.width,
                  height: rect.height,
                },
                source: "foliate",
                format: book.format === "pdf" ? "pdf" : "epub",
                locale: range.startContainer.ownerDocument?.documentElement.lang || undefined,
              });
            }).catch(() => {});
          }, 240);
        }
      }) as EventListener);

      const savedLocation = currentCfiRef.current || book.current_cfi;
      let startLocation: string | undefined = savedLocation || undefined;
      if (!startLocation && book.format === "pdf") {
        startLocation = getPdfStartCfi(
          book.progress,
          view.book?.sections?.length ?? book.pages,
        );
      }
      // On a first open (no saved position), foliate's `showTextStart` jumps to
      // the EPUB `bodymatter`/`text` landmark, skipping front matter (cover,
      // contents, acclaim, foreword…). Most e-readers do this, so it stays the
      // default; users who want to start at the very first section can turn it
      // off via the `skip_front_matter` setting. Read at open time so the
      // choice takes effect on the next book open. Only matters when there is
      // no saved location, so skip the read on the common resume path.
      const skipFrontMatter = startLocation
        ? true
        : await invoke<string | null>("get_setting", { key: "skip_front_matter" })
          .then((value) => value !== "false")
          .catch(() => true);
      logReaderDiagnostic("reader.open.init-start", `startLocation=${startLocation ?? "-"}`);
      try {
        await withTimeout(
          view.init({ lastLocation: startLocation, showTextStart: !startLocation && skipFrontMatter }),
          45_000,
          "READER_INIT_TIMEOUT",
        );
      } catch (error) {
        // A stale or unresolvable saved location (e.g. a CFI synced from a
        // different device or an earlier format) can make foliate's `goTo`
        // hang on the restore navigation, which surfaces as READER_INIT_TIMEOUT
        // and leaves the book permanently unopenable. When we started from a
        // saved location, fall back once to opening without it so the book
        // still opens; the reader then relocates and overwrites the bad CFI on
        // the next progress save.
        const isTimeout = error instanceof Error && error.message === "READER_INIT_TIMEOUT";
        if (cancelled || !isTimeout || !startLocation) throw error;
        logIgnoredError("reader.init-timeout-retry", error);
        currentCfiRef.current = null;
        await withTimeout(
          view.init({ lastLocation: undefined, showTextStart: skipFrontMatter }),
          45_000,
          "READER_INIT_TIMEOUT",
        );
      }
      if (cancelled) return;
      logReaderDiagnostic("reader.open.init-done");
      setBookReady(true);
      logReaderDiagnostic("reader.open.ready");
    };

    const initialization = initFoliate();
    initialization.catch((error) => {
      if (cancelled) return;
      console.error("Failed to initialize foliate-js:", error);
      logReaderDiagnostic("reader.open.failed", error);
      if (activeView) {
        activeView.remove();
        try {
          activeView.close();
        } catch (closeError) {
          logIgnoredError("reader.close-after-open-failure", closeError);
        }
      }
      if (viewRef.current === activeView) viewRef.current = null;
      setReaderError(toReaderOpenError(error, book.render_format || book.format));
      setBookReady(false);
    });

    return () => {
      cancelled = true;
      fetchAbort.abort();
      readerInteractionGenerationRef.current += 1;
      cancelPendingWordClick();
      cancelPendingSelectionMenu();
      annotationClickDocumentRef.current = null;
      if (activeView) {
        disposeFoliateViewAfterInitialization(
          activeView,
          initialization,
          (error) => logIgnoredError("reader.close-after-cancel", error),
        );
        if (viewRef.current === activeView) viewRef.current = null;
      }
      // Only `.remove()`, never `.close()` — the staging host's nested view(s)
      // share the main view's `book` instance, and closing one closes it for
      // both (see View.close() in view.js).
      footnoteStagingHost?.remove();
      setFootnote(null);
    };
    // `openKey` is the whole dependency on purpose — see the comment where it
    // is built. Everything else the body reads is either derived from it, or
    // reached through a ref precisely so it cannot reopen the book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view?.renderer) return;
    if (capabilities.supportsReflowSettings) {
      const viewport = viewerRef.current ?? view;
      // Styles first, layout second: the columnize pass inside applyReflowLayout
      // has to measure the document at its final font size.
      const measure = getReaderMeasure(readerSettings, viewport.clientWidth, viewport.clientHeight);
      appliedFontSizeRef.current = measure.fontSize;
      view.renderer.setStyles?.(getReaderCSS(readerSettings, measure.fontSize));
      applyReflowLayout(view, readerSettings, viewport.clientWidth, viewport.clientHeight);
    } else if (capabilities.supportsSpread) {
      if (book?.format === "pdf") {
        const viewport = viewerRef.current ?? view;
        applyPdfLayout(view, readerSettings, viewport.clientWidth, viewport.clientHeight);
      } else {
        view.renderer.setAttribute("max-column-count", String(readerSettings.pageColumns));
      }
    }
  }, [book?.format, bookReady, capabilities, readerSettings, viewRef, viewerRef]);

  useEffect(() => {
    if (!bookReady || !capabilities.supportsReflowSettings || !viewerRef.current) return;
    let frame = 0;
    const viewer = viewerRef.current;
    const applyCurrentLayout = () => {
      const view = viewRef.current;
      if (view?.renderer) {
        // Foliate re-columnizes synchronously inside these setAttribute calls,
        // so this delta is the real cost of the reflow the user feels on drag.
        const started = performance.now();
        // A resize can cross the narrow-viewport threshold, which changes the
        // size the text renders at. Rewriting the stylesheet costs a reflow, so
        // only do it when that resolved size actually moved — and do it before
        // the columnize pass, which has to measure the final size.
        const measure = getReaderMeasure(
          readerSettingsRef.current,
          viewer.clientWidth,
          viewer.clientHeight,
        );
        if (measure.fontSize !== appliedFontSizeRef.current) {
          appliedFontSizeRef.current = measure.fontSize;
          view.renderer.setStyles?.(getReaderCSS(readerSettingsRef.current, measure.fontSize));
        }
        // Re-columnizing puts different text on the page, and foliate's own
        // re-anchor works off the whole previously-visible range — when the new
        // columns are shorter that range no longer fits and the page can land
        // somewhere else. Hold the location across the relayout: `relocate`
        // fires synchronously from inside applyReflowLayout, so the reading
        // either side of it is a genuine before/after pair.
        const anchorBefore = currentCfiRef.current;
        applyReflowLayout(
          view,
          readerSettingsRef.current,
          viewer.clientWidth,
          viewer.clientHeight,
        );
        recordReflowTiming(performance.now() - started);
        if (anchorBefore && movedDuringReflow(anchorBefore, currentCfiRef.current)) {
          void view.goTo?.(anchorBefore, { history: false });
        }
        // Passive-vocab notes pick margin rail or ruby from the window width at
        // install time. Crossing that threshold mid-session leaves rails in a
        // window too narrow for them (or ruby in one that has room again), so
        // re-install once here — after the reflow, so the new rects are final.
        const narrow = isNarrowPassiveVocabViewport(window.innerWidth);
        if (narrow !== appliedNarrowViewportRef.current) {
          appliedNarrowViewportRef.current = narrow;
          applyPassiveVocabAnnotationsRef.current();
        }
      }
    };
    const scheduleLayout = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyCurrentLayout();
      });
    };
    const resize = () => {
      // While the side panel is dragged the viewer resizes every frame. Skip
      // those intermediate reflows — dragObserver relayouts once when the drag
      // ends (see below), so we never pay for the expensive columnize mid-drag.
      if (viewRef.current?.renderer?.hasAttribute("resize-dragging")) return;
      scheduleLayout();
    };
    const observer = new ResizeObserver(resize);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    observer.observe(viewer);
    reducedMotion.addEventListener("change", resize);

    // Relayout the instant the drag ends. Foliate's paginator already
    // re-renders synchronously when `resize-dragging` is removed, but it uses
    // the pre-drag column width; scheduling our own reflow in the same frame
    // overwrites that stale render before it paints — no flash, no 200ms lag.
    const renderer = viewRef.current?.renderer as Element | undefined;
    let dragObserver: MutationObserver | undefined;
    if (renderer) {
      dragObserver = new MutationObserver(() => {
        if (!renderer.hasAttribute("resize-dragging")) scheduleLayout();
      });
      dragObserver.observe(renderer, {
        attributes: true,
        attributeFilter: ["resize-dragging"],
      });
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      dragObserver?.disconnect();
      reducedMotion.removeEventListener("change", resize);
    };
  }, [bookReady, capabilities.supportsReflowSettings, currentCfiRef, readerSettingsRef, viewRef, viewerRef]);

  useEffect(() => {
    if (!bookReady || book?.format !== "pdf") return;
    const renderer = viewRef.current?.renderer;
    const foliateBook = viewRef.current?.book;
    if (!renderer || !foliateBook?.getPageSize) return;
    let cancelled = false;
    const update = async () => {
      try {
        const effectiveColumns = getEffectivePageColumns(
          readerSettingsRef.current,
          renderer.clientWidth,
          renderer.clientHeight,
        );
        const first = await foliateBook.getPageSize(0);
        const second = effectiveColumns === 2
          ? await foliateBook.getPageSize(1).catch(() => null)
          : null;
        if (cancelled || !first?.width) return;
        const rowWidth = first.width + (second?.width ?? 0);
        fitPctRef.current = Math.round(
          (Math.max(renderer.clientWidth - 24, 1) / rowWidth) * 100,
        );
      } catch {
        // The book can close while an async page-size read is in flight.
      }
    };
    void update();
    const observer = new ResizeObserver(update);
    observer.observe(renderer);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [
    book?.format,
    bookReady,
    fitPctRef,
    readerSettings.pageColumns,
    readerSettings.readingMode,
    readerSettingsRef,
    viewRef,
  ]);

  useEffect(() => {
    if (!bookReady || book?.format !== "pdf" || !viewerRef.current) return;
    let frame = 0;
    let trailingTimer: number | null = null;
    const viewer = viewerRef.current;
    const relayoutPdf = () => {
      const renderer = viewRef.current?.renderer as (HTMLElement & {
        relayout?: () => void;
      }) | undefined;
      if (!renderer) return;
      const view = viewRef.current;
      if (view) {
        applyPdfLayout(
          view,
          readerSettingsRef.current,
          viewer.clientWidth,
          viewer.clientHeight,
        );
      }
      if (typeof renderer.relayout === "function") {
        renderer.relayout();
        return;
      }
      const zoom = zoomRef.current;
      renderer.setAttribute("zoom", zoom === "fit" ? "fit-width" : String(zoom / 100));
    };
    const observer = new ResizeObserver(() => {
      const renderer = viewRef.current?.renderer;
      if (renderer?.hasAttribute("resize-dragging")) {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        if (trailingTimer !== null) window.clearTimeout(trailingTimer);
        const runAfterDrag = () => {
          trailingTimer = null;
          if (viewRef.current?.renderer?.hasAttribute("resize-dragging")) {
            trailingTimer = window.setTimeout(runAfterDrag, 200);
            return;
          }
          relayoutPdf();
        };
        trailingTimer = window.setTimeout(runAfterDrag, 200);
        return;
      }
      if (trailingTimer !== null) {
        window.clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        relayoutPdf();
      });
    });
    observer.observe(viewer);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      observer.disconnect();
    };
  }, [book?.format, bookReady, readerSettingsRef, viewRef, viewerRef, zoomRef]);
}
