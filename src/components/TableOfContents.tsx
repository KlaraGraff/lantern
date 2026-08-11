import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-react";
import { logIgnoredError } from "../utils/logIgnoredError";
import {
  mergeExpandedPages,
  serializeExpandedPages,
  tocStateSettingKeys,
  type TocSavedState,
} from "./toc-state";

interface Chapter {
  title: string;
  page: number;
  depth: number;
  disabled?: boolean;
}

interface TableOfContentsProps {
  open: boolean;
  chapters: Chapter[];
  currentPage: number;
  onNavigate: (page: number) => void;
  /** When set, the expanded-node set and scroll position persist per book. */
  bookId?: string;
  /** Restored state for `bookId`, once its per-book settings have loaded. */
  savedState?: TocSavedState;
}

interface TocRow extends Chapter {
  parentPage?: number;
  hasChildren: boolean;
}

interface PendingTocSave {
  bookId: string;
  expanded?: string;
  scroll?: number;
}

function TableOfContents({
  open,
  chapters,
  currentPage,
  onNavigate,
  bookId,
  savedState,
}: TableOfContentsProps) {
  const { t } = useTranslation();
  const activeRef = useRef<HTMLButtonElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [expandedPages, setExpandedPages] = useState<Set<number>>(() => new Set());

  const rows = useMemo(() => {
    const result: TocRow[] = [];
    const stack: TocRow[] = [];
    for (const chapter of chapters) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= chapter.depth) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.hasChildren = true;
      const row: TocRow = { ...chapter, parentPage: parent?.page, hasChildren: false };
      result.push(row);
      stack.push(row);
    }
    return result;
  }, [chapters]);
  const readingUnitCount = useMemo(
    () => rows.filter((row) => !row.hasChildren).length,
    [rows],
  );

  const rowsByPage = useMemo(() => new Map(rows.map((row) => [row.page, row])), [rows]);

  const activePathPages = useMemo(() => {
    const path: number[] = [];
    let row = rowsByPage.get(currentPage);
    while (row) {
      path.push(row.page);
      row = row.parentPage !== undefined ? rowsByPage.get(row.parentPage) : undefined;
    }
    return path;
  }, [currentPage, rowsByPage]);

  const shouldScrollActiveRef = useRef(false);
  const wasOpenRef = useRef(open);
  // One-shot restore target, populated once `savedState` arrives and consumed
  // the first time the panel opens for this book.
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PendingTocSave | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) shouldScrollActiveRef.current = true;
    wasOpenRef.current = open;
  }, [open]);

  // A fresh book starts from a clean slate — the previous book's expanded rows
  // and any pending scroll restore must not leak across a switch.
  useEffect(() => {
    setExpandedPages(new Set());
    pendingScrollRestoreRef.current = null;
  }, [bookId]);

  // Layer the restored per-book state on top of whatever's already expanded
  // (rather than replacing it), so this can arrive before or after the
  // auto-expand effect below without either one clobbering the other.
  useEffect(() => {
    if (!savedState) return;
    setExpandedPages((prev) => mergeExpandedPages(prev, savedState.expandedPages));
    pendingScrollRestoreRef.current = savedState.scrollTop ?? null;
  }, [savedState]);

  useEffect(() => {
    if (!open) return;
    setExpandedPages((prev) => {
      const next = mergeExpandedPages(prev, activePathPages);
      return next.size === prev.size ? prev : next;
    });
  }, [activePathPages, open]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    let parentPage = row.parentPage;
    while (parentPage !== undefined) {
      if (!expandedPages.has(parentPage)) return false;
      parentPage = rowsByPage.get(parentPage)?.parentPage;
    }
    return true;
  }), [expandedPages, rows, rowsByPage]);

  useEffect(() => {
    if (!open || !shouldScrollActiveRef.current) return;
    const restoreScrollTop = pendingScrollRestoreRef.current;
    if (restoreScrollTop !== null) {
      shouldScrollActiveRef.current = false;
      pendingScrollRestoreRef.current = null;
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = restoreScrollTop;
      });
      return;
    }
    if (!activeRef.current) return;
    shouldScrollActiveRef.current = false;
    requestAnimationFrame(() => activeRef.current?.scrollIntoView({ block: "center" }));
  }, [open, visibleRows]);

  // Debounced write-through to the per-book settings table: a dragged scroll or
  // a burst of expand/collapse clicks must not fire one DB write per event.
  const flushTocStateSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pending) return;
    const settings: Record<string, string> = {};
    if (pending.expanded !== undefined) settings[tocStateSettingKeys.expanded] = pending.expanded;
    if (pending.scroll !== undefined) settings[tocStateSettingKeys.scroll] = String(pending.scroll);
    if (Object.keys(settings).length === 0) return;
    invoke("set_book_settings_bulk", { bookId: pending.bookId, settings }).catch((error: unknown) => {
      // Low-stakes UI state — a dropped write just means the next toggle/scroll
      // retries with fresh values; not worth cross-book-safe retry plumbing.
      logIgnoredError("reader.toc-state-save", error);
    });
  }, []);

  const scheduleTocStateSave = useCallback((patch: { expanded?: string; scroll?: number }) => {
    if (!bookId) return;
    pendingSaveRef.current = {
      bookId,
      ...(pendingSaveRef.current?.bookId === bookId ? pendingSaveRef.current : {}),
      ...patch,
    };
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushTocStateSave, 400);
  }, [bookId, flushTocStateSave]);

  // Flush on unmount and on every book switch — the pending write still targets
  // the book it was queued under (captured in `pendingSaveRef`), not whichever
  // book is open by the time the timer would otherwise have fired.
  useEffect(() => () => {
    flushTocStateSave();
  }, [bookId, flushTocStateSave]);

  if (!open) return null;

  const toggleRow = (page: number) => {
    const next = new Set(expandedPages);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setExpandedPages(next);
    scheduleTocStateSave({ expanded: serializeExpandedPages(next) });
  };

  const handleScroll = () => {
    const scrollTop = scrollContainerRef.current?.scrollTop;
    if (scrollTop === undefined) return;
    scheduleTocStateSave({ scroll: scrollTop });
  };

  return (
    // No width and no docking here. The reader decides whether this is a 320px
    // column beside the page or the whole reading area, and a panel that names
    // its own `w-80` cannot be told the second thing. The right border goes
    // with the column: it separates the panel from the page, and with no page
    // beside it it is just a line down the edge of the screen.
    <aside
      aria-label={t("reader.tocTitle")}
      className="flex h-full min-h-0 w-full flex-col bg-bg-muted md:border-r md:border-border"
    >
      <div className="shrink-0 border-b border-border px-5 py-3 bg-bg-surface">
        <h2 className="text-[15px] font-semibold text-text-primary leading-5">
          {t("reader.tocTitle")}
        </h2>
        <p className="text-[12px] text-text-muted leading-4 mt-0.5">
          {t("reader.tocCount", { count: readingUnitCount })}
        </p>
      </div>
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3"
      >
        <div className="flex flex-col gap-1">
          {visibleRows.map((chapter) => {
            const isActive = currentPage === chapter.page;
            const isExpanded = expandedPages.has(chapter.page);
            const rowClassName = [
              "relative flex w-full min-w-0 items-start rounded-md pr-3 py-2 text-left transition-colors",
              isActive ? "bg-accent-bg" : chapter.disabled ? "" : "hover:bg-bg-input",
            ].join(" ");
            const labelClassName = [
              "block text-[13px] leading-5 break-words text-left",
              chapter.disabled ? "opacity-50 cursor-default" : "cursor-pointer",
              isActive
                ? "font-semibold text-accent-text"
                : chapter.depth === 0
                  ? "font-medium text-text-primary"
                  : "font-normal text-text-secondary",
            ].join(" ");

            return (
              <div
                key={chapter.page + "-" + chapter.title}
                style={{ paddingLeft: 4 + chapter.depth * 16 }}
                className={rowClassName}
              >
                {isActive && (
                  <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-accent" />
                )}
                {chapter.hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleRow(chapter.page)}
                    aria-label={t(isExpanded ? "reader.tocCollapseSection" : "reader.tocExpandSection")}
                    aria-expanded={isExpanded}
                    className="mt-0.5 mr-1 flex size-4 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-input"
                  >
                    <ChevronRight size={14} className={isExpanded ? "rotate-90 transition-transform" : "transition-transform"} />
                  </button>
                ) : (
                  <span className="mr-1 size-4 shrink-0" />
                )}
                <button
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => {
                    if (!chapter.disabled) onNavigate(chapter.page);
                  }}
                  disabled={chapter.disabled}
                  title={chapter.title}
                  className="min-w-0 flex-1"
                >
                  <span className={labelClassName}>{chapter.title}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// The reader keeps this mounted while closed (it only hides with CSS), so
// without `memo` it re-renders on every page turn.
export default memo(TableOfContents);
