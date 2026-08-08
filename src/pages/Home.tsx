import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, LayoutGrid, List, Plus, Upload, BookOpen, Loader, AlertCircle, X, Menu } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Sidebar from "../components/Sidebar";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import DictionaryContent from "../components/DictionaryContent";
import ChatsContent from "../components/ChatsContent";
import AnnotationsContent from "../components/AnnotationsContent";
import ExplanationsContent from "../components/ExplanationsContent";
import ProfileContent from "../components/ProfileContent";
import ReadingStatsContent from "../components/ReadingStatsContent";
import { openSettings } from "../components/settings-open";
import { listenForSettingsChanged } from "../components/settings-events";
import LibraryHintBanner from "../components/onboarding/LibraryHintBanner";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useBooks, importBookDialog, IMPORT_SLOW_HINT_MS } from "../hooks/useBooks";
import { summarizeImportFailures } from "../hooks/import-batch";
import { useCollections } from "../hooks/useCollections";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { platform } from "../services/platform";
import {
  useDrawerGesture,
  DRAWER_EDGE_ZONE_PX,
  DRAWER_SETTLE_MS,
  type DrawerGestureState,
} from "../hooks/useDrawerGesture";

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * The strip macOS needs left clear for its traffic lights, and its first real
 * consumer. Keyed to the platform and never to the width: the same window
 * dragged down to 400px still has them.
 */
const TOP_INSET = platform.hasTitleBarInset ? "pt-titlebar" : "pt-safe-top";

/** Only the fallback for a panel that has not been measured yet. */
const DRAWER_WIDTH_PX = 300;

/**
 * Set once, from JSX, and never written again: React diffs style objects by
 * value and this one never changes, so it will not fight the imperative writes
 * that follow. The drawer starts closed, one panel-width to the left.
 */
const CLOSED_PANEL_STYLE = { transform: "translate3d(-100%, 0, 0)" } as const;
const CLOSED_SCRIM_STYLE = { opacity: 0, pointerEvents: "none" } as const;
const EDGE_ZONE_STYLE = { width: DRAWER_EDGE_ZONE_PX } as const;

/**
 * `inert` is the honest way to take the page behind a modal out of the tab
 * order and the accessibility tree at once. Safari 17 and WKWebView have it;
 * the fallback is the one the spec's polyfill advice gives — hide it from
 * assistive technology and rely on the drawer's own focus trap for the keys.
 */
const SUPPORTS_INERT = typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;

/** Applied both to the page behind an open drawer and to a closed drawer. */
const unreachable = (yes: boolean): React.HTMLAttributes<HTMLDivElement> =>
  !yes ? {} : SUPPORTS_INERT ? { inert: true } : { "aria-hidden": true };

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Home() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSlow, setImportSlow] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ applied: number; total: number } | null>(null);
  const [userName, setUserName] = useState("");
  const collections = useCollections();

  const isNarrow = useIsNarrow();
  const drawerPanelRef = useRef<HTMLDivElement>(null);
  const drawerScrimRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  // The gesture never measures the DOM itself, so the travel distance is read
  // here and cached: reading `offsetWidth` inside a pointermove would force a
  // synchronous layout on every frame of the drag.
  const drawerTravelRef = useRef(DRAWER_WIDTH_PX);
  const drawer = useDrawerGesture({ width: () => drawerTravelRef.current });
  const drawerOpen = drawer.open;
  const setDrawerOpen = drawer.setOpen;

  // Picking anything in the sidebar is navigation, and navigation is done with
  // the drawer. On the desktop there is nothing to close.
  const handleFilterChange = useCallback((filter: string) => {
    setActiveFilter(filter);
    setDrawerOpen(false);
  }, [setDrawerOpen]);

  // A window dragged back out to desktop width unmounts the drawer; leaving the
  // controller open would mean the next drag back to narrow starts open.
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow, setDrawerOpen]);

  // The finger owns the position, React owns only the settled flag. Every frame
  // of a drag is written straight to the two elements' style — a setState per
  // pointermove would re-render the whole shelf behind the drawer, which is the
  // frame budget a phone does not have. The transition is attached only when
  // the finger is off; while it is down, an easing curve would lag the drag.
  useLayoutEffect(() => {
    if (!isNarrow) return;
    const panel = drawerPanelRef.current;
    const scrim = drawerScrimRef.current;
    if (!panel || !scrim) return;

    const measure = () => {
      drawerTravelRef.current = panel.offsetWidth || DRAWER_WIDTH_PX;
    };
    const paint = (state: DrawerGestureState) => {
      const offset = (state.fraction - 1) * drawerTravelRef.current;
      panel.style.transition = state.dragging ? "none" : `transform ${DRAWER_SETTLE_MS}ms ease-out`;
      panel.style.transform = `translate3d(${offset}px, 0, 0)`;
      scrim.style.transition = state.dragging ? "none" : `opacity ${DRAWER_SETTLE_MS}ms ease-out`;
      scrim.style.opacity = String(state.fraction);
      // A fully transparent scrim still swallows every tap on the shelf.
      scrim.style.pointerEvents = state.fraction > 0 ? "auto" : "none";
    };

    measure();
    paint(drawer.getState());
    const unsubscribe = drawer.subscribe(paint);
    window.addEventListener("resize", measure);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", measure);
    };
  }, [isNarrow, drawer]);

  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (!isNarrow) {
      wasDrawerOpen.current = false;
      return;
    }
    if (drawerOpen) {
      drawerPanelRef.current?.focus({ preventScroll: true });
    } else if (wasDrawerOpen.current) {
      // Only after a drawer that was actually open — otherwise the page would
      // steal focus to the hamburger on first paint.
      hamburgerRef.current?.focus({ preventScroll: true });
    }
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen, isNarrow]);

  const handleDrawerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setDrawerOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const panel = drawerPanelRef.current;
    if (!panel) return;
    // An iPad with a keyboard is an ordinary setup, so this path is not
    // optional. `offsetParent` filters the controls the `touch:` variants have
    // hidden — a tab stop nobody can see is a trap of its own.
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, [setDrawerOpen]);

  const drawerPointer = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      // A `false` here means the drawer wants nothing to do with this pointer.
      // Nothing is captured and nothing is prevented either way — doing either
      // on a pointer the controller rejected is what stops the shelf scrolling.
      drawer.onPointerDown({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      drawer.onPointerMove({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      // Capture only once the direction lock has opened. Capturing on
      // pointerdown would retarget the following `click` to this element, and
      // every row inside the open drawer would go dead.
      if (drawer.getState().dragging && !event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      drawer.onPointerUp({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      drawer.onPointerCancel({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    },
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      drawer.onLostPointerCapture({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
    },
  };

  // The name greets the reader in the sidebar. Tracking the save rather than
  // the settings modal closing keeps it correct wherever the edit came from —
  // the modal itself is mounted above this page now and never reports back.
  useEffect(() => {
    invoke<Record<string, string>>("get_all_settings")
      .then((s) => setUserName(s.user_name ?? ""))
      .catch(() => {});
    const unlisten = listenForSettingsChanged((values) => {
      if ("user_name" in values) setUserName(values.user_name ?? "");
    });
    return () => { unlisten.then((stop) => stop()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWebview().listen<string>("open-library-filter", (event) => {
      setActiveFilter(event.payload || "all");
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // A word annotation links to the vocabulary tab. The tab switch is the whole
  // contract today; the event carries the word for the vocabulary page to
  // focus if it ever wants to, and is harmlessly unheard until then.
  const openVocabWord = useCallback((word: string) => {
    setActiveFilter("vocab");
    window.dispatchEvent(new CustomEvent("vocab-open-word", { detail: { word } }));
  }, []);

  // The reader sends readers here to review with a navigation intent rather
  // than a global event, so it survives Home not being mounted yet. Cleared
  // right after acting on it, same as Reader.tsx's openVocab handler, so a
  // later back/forward through history doesn't replay it.
  useEffect(() => {
    const state = location.state as { openReview?: boolean } | null;
    if (!state?.openReview) return;
    setActiveFilter("review");
    navigate(location.pathname, { replace: true });
  }, [location.state, location.pathname, navigate]);

  const isCollectionFilter = activeFilter.startsWith("collection:");
  const statusFilter = !isCollectionFilter && activeFilter !== "all" ? activeFilter : undefined;
  const collectionId = isCollectionFilter ? activeFilter.replace("collection:", "") : undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const searchParam = debouncedSearchQuery || undefined;

  const { books, loading, hasMore, loadMore, loadingMore, refresh } = useBooks(statusFilter, searchParam, collectionId);

  // Book counts for sidebar badges — lightweight, no book data loaded.
  const [bookCounts, setBookCounts] = useState({ all: 0, reading: 0, finished: 0 });
  const refreshCounts = useCallback(async () => {
    try {
      const counts = await invoke<{ all: number; reading: number; finished: number }>("get_book_counts");
      setBookCounts(counts);
    } catch (err) {
      console.error("Failed to load book counts:", err);
    }
  }, []);
  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  // Today's due-for-review count, for the sidebar's words-row badge. Uses
  // `get_vocab_stats` rather than `list_vocab_due_for_review` — the badge only
  // needs a number, and the stats command returns just that over IPC instead
  // of every column of every due word.
  const [dueForReviewCount, setDueForReviewCount] = useState(0);
  const refreshDueForReviewCount = useCallback(async () => {
    try {
      const stats = await invoke<{ due_for_review: number }>("get_vocab_stats");
      setDueForReviewCount(stats.due_for_review);
    } catch (err) {
      console.error("Failed to load vocab stats:", err);
    }
  }, []);
  useEffect(() => { refreshDueForReviewCount(); }, [refreshDueForReviewCount]);
  // `vocab-changed` covers saves, mastery updates and recorded reviews (see
  // useDictionary.ts); `focus` catches anything that happened while another
  // window — or the OS review-in-background flow — had the reader's attention.
  useEffect(() => {
    window.addEventListener("vocab-changed", refreshDueForReviewCount);
    window.addEventListener("focus", refreshDueForReviewCount);
    return () => {
      window.removeEventListener("vocab-changed", refreshDueForReviewCount);
      window.removeEventListener("focus", refreshDueForReviewCount);
    };
  }, [refreshDueForReviewCount]);

  // Keep stable refs for refresh functions so the drag-drop effect doesn't re-register
  const refreshRef = useRef(refresh);
  const countsRefreshRef = useRef(refreshCounts);
  const collectionsRefreshRef = useRef(collections.refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { countsRefreshRef.current = refreshCounts; }, [refreshCounts]);
  useEffect(() => { collectionsRefreshRef.current = collections.refresh; }, [collections.refresh]);

  // Auto-dismiss import error after 10s
  useEffect(() => {
    if (!importError) return;
    const timer = setTimeout(() => setImportError(null), 10000);
    return () => clearTimeout(timer);
  }, [importError]);

  // After 5s of any import, hint that things are slower than usual so the
  // user knows the app hasn't frozen. Healthy imports finish in 1–5s; past
  // that, either pdf.js is stalled (PDF_METADATA_TIMEOUT_MS) or the Rust
  // EPUB path is grinding on a large file.
  useEffect(() => {
    if (!importing) {
      setImportSlow(false);
      return;
    }
    const timer = setTimeout(() => setImportSlow(true), IMPORT_SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [importing]);

  useEffect(() => {
    const unlistenTick = listen("sync-initial-tick-done", () => {
      setSyncProgress(null);
      refreshRef.current();
      countsRefreshRef.current();
      collectionsRefreshRef.current();
    });
    const unlistenProgress = listen<{ applied: number; total: number }>("sync-progress", (e) => {
      setSyncProgress(e.payload);
    });
    return () => {
      unlistenTick.then((fn) => fn());
      unlistenProgress.then((fn) => fn());
    };
  }, []);

  // Refresh when MCP subprocess writes to the library.
  // Debounced: bulk MCP imports fire hundreds of events in quick
  // succession; without the delay each one triggers a full book list
  // reload, which can OOM/freeze the webview.
  useEffect(() => {
    let mcpDebounce: ReturnType<typeof setTimeout> | null = null;
    const unlistenBooks = listen("mcp:books-changed", () => {
      if (mcpDebounce) clearTimeout(mcpDebounce);
      mcpDebounce = setTimeout(() => {
        refreshRef.current();
        countsRefreshRef.current();
        collectionsRefreshRef.current();
      }, 500);
    });
    const unlistenCollections = listen("mcp:collections-changed", () => {
      collectionsRefreshRef.current();
      refreshRef.current();
      countsRefreshRef.current();
    });
    return () => {
      if (mcpDebounce) clearTimeout(mcpDebounce);
      unlistenBooks.then((fn) => fn());
      unlistenCollections.then((fn) => fn());
    };
  }, []);

  // Covers arrive a tick or two after the books they belong to (the sync
  // engine triggers their iCloud download, then ingests the bytes into the
  // cover_data BLOB on a later watcher tick). Refresh so blank cover cards
  // fill in on their own. Debounced: covers land in bursts.
  useEffect(() => {
    let coverDebounce: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen("sync-covers-ingested", () => {
      if (coverDebounce) clearTimeout(coverDebounce);
      coverDebounce = setTimeout(() => refreshRef.current(), 500);
    });
    return () => {
      if (coverDebounce) clearTimeout(coverDebounce);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Text imports are prepared in the background after their source file has
  // been copied. Refresh their card state as each task starts or finishes.
  useEffect(() => {
    const unlisten = listen("book-preparation-changed", () => {
      refreshRef.current();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Native drag/drop imports are handled by Rust so a webview command never
  // receives an arbitrary absolute path. This listener only owns the visual
  // drop state.
  useEffect(() => {
    if (!platform.hasDragDrop) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragging(true);
      } else {
        setIsDragging(false);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Covers native file association and drag/drop imports. The backend emits
  // these after the copy has completed, so a refresh cannot race the import.
  useEffect(() => {
    const unlistenSuccess = listen("book-imported", () => {
      refreshRef.current();
      countsRefreshRef.current();
    });
    const unlistenFailure = listen<string>("book-import-failed", (event) => {
      setImportError(formatError(event.payload));
    });
    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenFailure.then((fn) => fn());
    };
  }, []);

  const displayBooks = books;

  const handleImport = async () => {
    try {
      setImporting(true);
      try {
        const result = await importBookDialog.importFiles();
        if (result.imported.length > 0) {
          refresh();
          refreshCounts();
        }
        const failureSummary = summarizeImportFailures(result.failures);
        if (failureSummary.kind === "singleFailure") {
          setImportError(failureSummary.message);
        } else if (failureSummary.kind === "batchFailure") {
          setImportError(t("import.batchFailedCount", { count: failureSummary.failedCount }));
        }
      } finally {
        setImporting(false);
      }
    } catch (err) {
      console.error("Failed to import book:", err);
      setImportError(formatError(err));
    }
  };

  const title =
    activeFilter === "all"
      ? t("home.title.all")
      : activeFilter === "reading"
        ? t("home.title.reading")
        : activeFilter === "finished"
          ? t("home.title.finished")
          : isCollectionFilter
            ? t("home.title.collection")
            : activeFilter;

  // One set of props, two possible containers — the sidebar itself never learns
  // which one it is in beyond the shell it should wear.
  const sidebarProps = {
    activeFilter,
    onFilterChange: handleFilterChange,
    bookCounts,
    dueForReviewCount,
    collections,
    userName,
    onOpenSettings: () => {
      openSettings();
      setDrawerOpen(false);
    },
    syncProgress,
  };

  const backgroundProps = unreachable(isNarrow && drawerOpen);

  const content =
    activeFilter === "vocab" ? (
        <DictionaryContent />
      ) : activeFilter === "review" ? (
        <DictionaryContent initialView="review" />
      ) : activeFilter === "chats" ? (
        <ChatsContent />
      ) : activeFilter === "notes" ? (
        <AnnotationsContent onOpenVocab={openVocabWord} />
      ) : activeFilter === "explanations" ? (
        <ExplanationsContent />
      ) : activeFilter === "profile" ? (
        <ProfileContent />
      ) : activeFilter === "stats" ? (
        <ReadingStatsContent onOpenReview={() => setActiveFilter("review")} />
      ) : (
        <main className="flex-1 flex flex-col min-w-0">
          <div className="border-b border-border px-page pb-section relative select-none">
            {/* Reserved for the traffic lights, and only where there are any.
                This is a platform question, not a width one — a macOS window
                dragged narrow still has them. */}
            {platform.hasTitleBarInset && <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-titlebar" />}
            <div className={`${TOP_INSET} flex items-center justify-between mb-4`}>
              {isNarrow && (
                <Button
                  ref={hamburgerRef}
                  variant="icon"
                  size="md"
                  className="touch:size-11 -ml-2 mr-1"
                  aria-label={t("home.openSidebar")}
                  aria-expanded={drawerOpen}
                  onClick={() => setDrawerOpen(true)}
                >
                  <Menu size={20} />
                </Button>
              )}
              {/* `md:flex-initial` is the CSS initial value, so the desktop row
                  is the two-item `justify-between` it has always been. */}
              <h1 className="flex-1 md:flex-initial text-[21px] md:text-[24px] font-semibold text-text-primary tracking-[0.07px]">
                {title}
              </h1>
              <div data-tauri-drag-region className="flex items-center gap-0">
                <Button
                  variant="icon"
                  size="md"
                  active={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid size={16} />
                </Button>
                <Button
                  variant="icon"
                  size="md"
                  active={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  <List size={16} />
                </Button>
              </div>
            </div>

            <Input
              icon={<Search size={16} />}
              placeholder={t("home.search")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full md:w-[448px]"
            />
          </div>

          <LibraryHintBanner />

          <div className="flex-1 overflow-auto p-page pb-20">
            {loading ? (
              <p className="text-text-muted text-[14px]">{t("home.loading")}</p>
            ) : displayBooks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <p className="text-text-muted text-[14px]">
                  {searchQuery
                    ? t("home.noResults")
                    : isCollectionFilter
                      ? t("home.noCollectionBooks")
                      : activeFilter !== "all"
                        ? t("home.noFilteredBooks", { filter: activeFilter })
                        : t(platform.hasFormatConvert ? "home.empty" : "home.emptyNoConvert")}
                </p>
                {activeFilter === "all" && !searchQuery && (
                  <Button variant="primary" size="md" onClick={handleImport}>
                    <Plus size={16} />
                    {t("home.importBook")}
                  </Button>
                )}
              </div>
            ) : viewMode === "grid" ? (
              <BookGrid books={displayBooks} hasMore={hasMore} loadMore={loadMore} loadingMore={loadingMore} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); refreshCounts(); collections.refresh();}} />
            ) : (
              <BookList books={displayBooks} hasMore={hasMore} loadMore={loadMore} loadingMore={loadingMore} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); refreshCounts(); collections.refresh();}} />
            )}
          </div>

          {/* `100dvh` puts the bottom of the layout at the bottom of the visible
              viewport, which on a phone is where the home indicator sits. The
              inset is 0 everywhere else, so this only ever adds on a device
              that reports one. */}
          <div className={`shrink-0 mx-page ${isNarrow ? "mb-[calc(var(--spacing-safe-bottom)+var(--spacing-page))]" : "mb-page"} flex flex-col items-center gap-1.5`}>
            <button
              onClick={handleImport}
              className="w-full rounded-lg border border-dashed border-text-muted/40 py-4 flex items-center justify-center gap-2 text-[14px] text-text-secondary hover:border-accent hover:text-accent transition-colors cursor-pointer"
            >
              <Upload size={16} />
              {/* Same button either way — only the invitation to drop is a lie
                  on a platform that cannot receive a drop. */}
              {platform.hasDragDrop ? t("home.dropHint") : t("home.importHint")}
            </button>
            {/* The moment someone wants a book is the moment they have none —
                so the list of places to find one belongs here, not only in a
                settings tab they have no reason to open. */}
            <button
              onClick={() => openSettings("library")}
              className="text-[12px] text-text-muted hover:text-accent transition-colors"
            >
              {t("home.findBooks")}
            </button>
          </div>
        </main>
      );

  return (
    // `h-dvh`, not `h-screen`: `100vh` on iOS measures the *largest* viewport,
    // which runs the bottom of the layout underneath the home indicator.
    // The pointer handlers sit here rather than on the drawer because a drag
    // that starts at the screen edge crosses the whole shelf, and everything
    // in the page bubbles to this element. The controller rejects any pointer
    // that is none of its business, and nothing is captured or prevented until
    // it claims one.
    <div className="relative flex h-dvh bg-bg-surface" {...(isNarrow ? drawerPointer : null)}>
      {!isNarrow && <Sidebar {...sidebarProps} />}

      {isNarrow ? (
        <div className="contents" {...backgroundProps}>
          {content}
        </div>
      ) : (
        content
      )}

      {isNarrow && (
        <>
          {/* The only place a closed drawer can be pulled from. It carries the
              touch-action rather than any pixels: `pan-y` leaves the vertical
              scroll to the browser and keeps the horizontal drag for us. */}
          <div
            aria-hidden="true"
            style={EDGE_ZONE_STYLE}
            className="fixed inset-y-0 left-0 z-30 touch-pan-y"
          />
          <div
            ref={drawerScrimRef}
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
            style={CLOSED_SCRIM_STYLE}
            className="fixed inset-0 z-40 bg-overlay touch-none"
          />
          <div
            ref={drawerPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("home.sidebarLabel")}
            tabIndex={-1}
            // A closed drawer is off-screen, not gone: without this it stays in
            // the tab order and a keyboard walks into an invisible sidebar.
            {...unreachable(!drawerOpen)}
            onKeyDown={handleDrawerKeyDown}
            style={CLOSED_PANEL_STYLE}
            className="fixed inset-y-0 left-0 z-50 w-[300px] max-w-[85%] touch-pan-y outline-none shadow-[8px_0_28px_0_rgba(0,0,0,0.22)]"
          >
            <Sidebar {...sidebarProps} inDrawer />
          </div>
        </>
      )}

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-dashed border-accent bg-bg-surface px-16 py-12 shadow-popover">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-bg">
              <BookOpen size={28} className="text-accent" />
            </div>
            <p className="text-[18px] font-semibold text-text-primary">
              {t("home.dropOverlay")}
            </p>
            <p className="text-[14px] text-text-muted">{t("home.dropFormats")}</p>
          </div>
        </div>
      )}

      {importing && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-bg-surface px-16 py-12 shadow-popover">
            <Loader size={28} className="text-accent animate-spin" />
            <p className="text-[18px] font-semibold text-text-primary">
              {t("home.importing")}
            </p>
            {importSlow && (
              <p className="max-w-[320px] text-center text-[13px] text-text-muted">
                {t("home.importingSlow")}
              </p>
            )}
          </div>
        </div>
      )}

      {importError && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[60] max-w-[600px] bg-white dark:bg-bg-surface border border-border rounded-[14px] shadow-popover flex items-start gap-3 pl-4 pr-3 py-3">
          <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("home.importError")}
            </p>
            <p className="text-[12px] text-text-secondary mt-0.5 break-words">
              {importError}
            </p>
          </div>
          <button
            onClick={() => setImportError(null)}
            className="shrink-0 size-6 flex items-center justify-center rounded-lg hover:bg-bg-input cursor-pointer transition-colors"
          >
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      )}
    </div>
  );
}
