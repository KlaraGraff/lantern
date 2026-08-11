import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { Search, SearchX } from "lucide-react";
import { useHighlights } from "../hooks/useBookmarks";
import { useDictionary } from "../hooks/useDictionary";
import { logIgnoredError } from "../utils/logIgnoredError";
import {
  countHits,
  filterGroupsByScope,
  isSearchableQuery,
  normalizeExcerpt,
  type BookSearchScope,
  type CfiModule,
  type SearchChapterGroup,
} from "../pages/reader/book-search";
import type { FoliateView } from "../pages/reader/foliate-types";
import { loadFoliateModules } from "../pages/reader/foliate-modules";

interface BookSearchPanelProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  viewRef: MutableRefObject<FoliateView | null>;
  /** Bumped by the reader on every ⌘F, even while already open, so the input re-focuses/re-selects. */
  focusToken: number;
  onNavigateToCfi: (cfi: string) => void;
}

/** How long typing pauses before a query actually runs — searching a whole book is expensive. */
const SEARCH_DEBOUNCE_MS = 400;

const SCOPES: BookSearchScope[] = ["book", "highlights", "vocab"];

export default function BookSearchPanel({
  open,
  onClose,
  bookId,
  viewRef,
  focusToken,
  onNavigateToCfi,
}: BookSearchPanelProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [scope, setScope] = useState<BookSearchScope>("book");
  const [rawGroups, setRawGroups] = useState<SearchChapterGroup[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<number | null>(null);
  const [cfiModule, setCfiModule] = useState<CfiModule | null>(null);
  const [lastClickedCfi, setLastClickedCfi] = useState<string | null>(null);
  const searchGenerationRef = useRef(0);

  const { highlights } = useHighlights(bookId);
  const { words } = useDictionary(bookId);

  // Esc closes, same as the other reader panels (AiPanel, FootnotePopover, …).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus (and select any existing text in) the input whenever the reader
  // asks — on first open, and again on every subsequent ⌘F.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusToken]);

  // A fresh book means a fresh query — the last book's results/CFIs mean
  // nothing here.
  useEffect(() => {
    setQuery("");
    setActiveQuery("");
    setRawGroups([]);
    setLastClickedCfi(null);
  }, [bookId]);

  // epubcfi.js lives in /public, so it comes in through the module bridge the
  // reader already uses elsewhere (highlight-ranges.ts) rather than a direct
  // dynamic import, which Vite's dev server refuses to serve.
  useEffect(() => {
    let cancelled = false;
    loadFoliateModules()
      .then((modules) => {
        if (!cancelled) setCfiModule(modules.epubcfi);
      })
      .catch((error: unknown) => logIgnoredError("reader.book-search-cfi", error));
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce: typing pauses before the (expensive, whole-book) search fires.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setActiveQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  // Runs (and cleanly supersedes) the engine search for `activeQuery`. A
  // generation token, bumped every time this effect re-runs, is checked after
  // every yield — the previous run's loop keeps executing in the background
  // (an async generator has no cancel API) but stops writing to state the
  // instant a newer query starts, so no stale results can land after it.
  useEffect(() => {
    const view = viewRef.current;
    const generation = ++searchGenerationRef.current;
    setRawGroups([]);
    setSearchProgress(null);
    setIsSearching(false);
    if (!open || !view) return;
    if (!isSearchableQuery(activeQuery)) {
      // Nothing left to show — and nothing left to show it in, either: drop
      // whatever matches the previous query annotated in the text.
      view.clearSearch();
      return;
    }
    setIsSearching(true);
    (async () => {
      try {
        for await (const result of view.search({ query: activeQuery })) {
          if (searchGenerationRef.current !== generation) return;
          if (result === "done") {
            setIsSearching(false);
            setSearchProgress(null);
            return;
          }
          if ("progress" in result) {
            setSearchProgress(result.progress);
          } else {
            setRawGroups((prev) => [...prev, { label: result.label, hits: result.subitems }]);
          }
        }
      } catch (error: unknown) {
        if (searchGenerationRef.current === generation) {
          setIsSearching(false);
          setSearchProgress(null);
        }
        logIgnoredError("reader.book-search", error);
      }
    })();
  }, [activeQuery, open, viewRef]);

  const scopeLocations = useMemo(() => {
    if (scope === "highlights") return highlights.map((highlight) => highlight.cfi_range);
    if (scope === "vocab") {
      return words
        .map((word) => word.cfi)
        .filter((cfi): cfi is string => Boolean(cfi));
    }
    return [];
  }, [scope, highlights, words]);

  const displayGroups = useMemo(() => {
    if (scope === "book") return rawGroups;
    if (!cfiModule) return [];
    return filterGroupsByScope(rawGroups, scope, scopeLocations, cfiModule);
  }, [rawGroups, scope, scopeLocations, cfiModule]);

  const resultCount = countHits(displayGroups);
  const hasQuery = isSearchableQuery(query);

  // Literal `t()` calls so the i18n key-usage scan (tests/i18n-keys.test.ts)
  // can see them — a key built from a template string would be invisible to it.
  const scopeLabels: Record<BookSearchScope, string> = {
    book: t("reader.search.scope.book"),
    highlights: t("reader.search.scope.highlights"),
    vocab: t("reader.search.scope.vocab"),
  };

  if (!open) return null;

  const handleResultClick = (cfi: string) => {
    setLastClickedCfi(cfi);
    onNavigateToCfi(cfi);
  };

  return (
    // Width and docking belong to the reader, not here — see the same note in
    // `TableOfContents`.
    <aside
      aria-label={t("reader.search.title")}
      className="flex h-full min-h-0 w-full flex-col bg-bg-muted md:border-r md:border-border"
    >
      <div className="shrink-0 border-b border-border px-5 py-3 bg-bg-surface flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold text-text-primary leading-5">
          {t("reader.search.title")}
        </h2>
        <div className="flex items-center gap-1.5 h-[30px] px-2 rounded-lg bg-bg-input border border-border">
          <Search size={13} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={t("reader.search.placeholder")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 min-w-0 text-[13px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <div className="flex gap-1">
          {SCOPES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setScope(candidate)}
              className={`flex-1 h-[26px] rounded-full text-[12px] font-medium cursor-pointer transition-colors ${
                scope === candidate
                  ? "bg-accent-bg text-accent-text"
                  : "text-text-muted hover:bg-bg-input"
              }`}
            >
              {scopeLabels[candidate]}
            </button>
          ))}
        </div>
        {hasQuery && (
          <p className="text-[12px] text-text-muted leading-4">
            {isSearching
              ? t("reader.search.progress", { percent: Math.round((searchProgress ?? 0) * 100) })
              : t("reader.search.resultCount", { count: resultCount })}
          </p>
        )}
      </div>

      {isSearching && (
        <div className="shrink-0 px-5 pt-2">
          <div className="h-1 w-full rounded-full bg-bg-input overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
              style={{ width: `${Math.round((searchProgress ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {!hasQuery ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <div className="size-12 rounded-full bg-bg-input flex items-center justify-center mb-3">
              <Search size={20} className="text-text-muted" />
            </div>
            <p className="text-[14px] text-text-muted">{t("reader.search.empty")}</p>
          </div>
        ) : displayGroups.length === 0 && !isSearching ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <div className="size-12 rounded-full bg-bg-input flex items-center justify-center mb-3">
              <SearchX size={20} className="text-text-muted" />
            </div>
            <p className="text-[14px] text-text-muted">
              {t("reader.search.noResults", { query: activeQuery })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {displayGroups.map((group) => (
              <div key={group.label}>
                <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  {group.label}
                </h3>
                <div className="flex flex-col gap-0.5">
                  {group.hits.map((hit) => {
                    const parts = normalizeExcerpt(hit.excerpt);
                    const isActive = lastClickedCfi === hit.cfi;
                    return (
                      <button
                        key={hit.cfi}
                        type="button"
                        onClick={() => handleResultClick(hit.cfi)}
                        className={`block w-full text-left rounded-md px-2 py-1.5 transition-colors ${
                          isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                        }`}
                      >
                        <span className="text-[13px] leading-5 text-text-secondary break-words">
                          {parts.pre}
                          <mark className="bg-transparent text-accent-text font-semibold">
                            {parts.match}
                          </mark>
                          {parts.post}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
