import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightFromLine, BookOpen, Loader2, Search, WandSparkles } from "lucide-react";
import Input from "./ui/Input";
import Select from "./ui/Select";
import { useOpenBook } from "../hooks/useOpenBook";
import { useExplanations, type Explanation } from "../hooks/useExplanations";
import AiMarkdown from "./ai-markdown/AiMarkdown";
import { timeAgo } from "../utils/timeAgo";

/**
 * The sidebar "解释" panel — every explanation the reader chose to keep,
 * across every book. "Moving one out" (the only destructive-looking action
 * here) doesn't delete anything: the cache row survives with `saved =
 * false`, so re-selecting the same passage still replays for free. That's
 * why the inline confirm below is styled neutral rather than danger-red —
 * see docs/impls/q257-persist-explanations.md §3.2.
 */
export default function ExplanationsContent() {
  const { t, i18n } = useTranslation();
  const openInReader = useOpenBook();
  const { items, total, books, hasMore, loadingMore, refresh, loadMore, remove } = useExplanations();
  const [search, setSearch] = useState("");
  const [bookId, setBookId] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Mounting this panel *is* "the filter becoming active" — Home swaps it in
  // and out of the ternary rather than hiding it, so there is no separate
  // "became active" event to listen for. The 180ms debounce mirrors
  // AnnotationsContent so fast typing doesn't fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      refresh(search, bookId)
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search, bookId, refresh]);

  // A save can happen in a reader window while this panel sits idle in the
  // background; window focus is the one signal every platform gives for
  // "the reader might come back and look." No cross-window push — see
  // plan §3.3.
  useEffect(() => {
    const onFocus = () => { refresh(search, bookId).catch(() => {}); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, search, bookId]);

  const bookOptions = useMemo(() => [
    { value: "", label: t("notes.filters.allBooks") },
    ...books
      .map((facet) => ({ value: facet.book_id, label: facet.book_title || t("common.unknownBook") }))
      .sort((left, right) => left.label.localeCompare(right.label, i18n.language)),
  ], [books, i18n.language, t]);

  const filtersActive = Boolean(search.trim() || bookId);

  const clearFilters = () => {
    setSearch("");
    setBookId("");
  };

  const moveOut = async (item: Explanation) => {
    await remove(item.id);
    setConfirmingId(null);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-surface">
      <header className="relative shrink-0 border-b border-border px-page pb-5 pt-titlebar">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-titlebar" />
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold text-text-primary">{t("explanations.title")}</h1>
            <p className="mt-1 text-[13px] text-text-muted">{t("explanations.subtitle")}</p>
          </div>
          <span className="text-[12px] text-text-muted">{t("explanations.count", { count: total })}</span>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Input
            icon={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("explanations.searchPlaceholder")}
            className="w-full md:min-w-[280px] md:flex-1"
          />
          <Select className="w-full md:w-[180px]" value={bookId} onChange={setBookId} options={bookOptions} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-page">
        {loading ? (
          <p className="text-[13px] text-text-muted">{t("home.loading")}</p>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-accent-bg text-accent-text">
              {filtersActive ? <Search size={22} /> : <WandSparkles size={22} />}
            </div>
            <p className="text-[14px] font-medium text-text-secondary">
              {filtersActive ? t("explanations.noResult") : t("explanations.empty")}
            </p>
            <p className="max-w-[380px] text-[12px] leading-[1.7] text-text-muted">
              {filtersActive ? t("explanations.noResultHint") : t("explanations.emptyHint")}
            </p>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="mt-1 h-8 rounded-md border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input">
                {t("annotations.clearFilters")}
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-[920px] divide-y divide-border-light">
            {items.map((item) => {
              const expanded = expandedId === item.id;
              const metaParts = [
                item.book_title || t("common.unknownBook"),
                item.chapter,
                timeAgo(item.updated_at),
              ].filter(Boolean);
              return (
                <article key={item.id} className="py-[18px] first:pt-0">
                  <div className="flex items-start gap-3">
                    {/* Not a <button>: the markdown body below can render block
                        elements (<p>, <ul>), which HTML forbids as button
                        descendants. role="button" gets the same affordance
                        without the invalid nesting. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setExpandedId(expanded ? null : item.id);
                        }
                      }}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                    >
                      <div className="border-l-2 border-[#c084fc] pl-3">
                        <p className="font-serif text-[12px] italic leading-[1.6] text-text-muted line-clamp-2">
                          {item.passage}
                        </p>
                      </div>
                      <AiMarkdown
                        size="compact"
                        className={`mt-2 text-[13px] leading-[1.7] text-text-secondary ${expanded ? "" : "line-clamp-3"}`}
                      >
                        {item.explanation}
                      </AiMarkdown>
                      <p className="mt-2.5 text-[11px] text-text-muted">{metaParts.join(" · ")}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.cfi !== "" && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); openInReader(item.book_id, { cfi: item.cfi }); }}
                          title={t("explanations.jumpBack")}
                          aria-label={t("explanations.jumpBack")}
                          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
                        >
                          <BookOpen size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setConfirmingId(item.id); }}
                        title={t("explanations.moveOut")}
                        aria-label={t("explanations.moveOut")}
                        className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
                      >
                        <ArrowRightFromLine size={14} />
                      </button>
                    </div>
                  </div>

                  {confirmingId === item.id && (
                    <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-border bg-bg-muted px-3 py-2.5">
                      <ArrowRightFromLine size={14} className="mt-0.5 shrink-0 text-text-muted" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-text-primary">
                          {t("explanations.moveOutConfirm.title")}
                        </p>
                        <p className="mt-1 text-[11px] leading-[1.55] text-text-muted">
                          {t("explanations.moveOutConfirm.body")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 self-center">
                        <button type="button" onClick={() => setConfirmingId(null)} className="h-7 rounded-md border border-transparent px-2.5 text-[11px] text-text-muted hover:bg-bg-input">
                          {t("common.cancel")}
                        </button>
                        <button type="button" onClick={() => moveOut(item).catch(() => {})} className="h-7 rounded-md border border-border bg-bg-surface px-2.5 text-[11px] font-medium text-text-primary hover:bg-bg-input">
                          {t("explanations.moveOutConfirm.confirm")}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
            {hasMore && (
              <div className="flex justify-center py-5">
                <button type="button" disabled={loadingMore} onClick={() => loadMore(search, bookId).catch(() => {})} className="flex h-9 items-center gap-2 rounded-md border border-border px-3.5 text-[12px] text-text-muted hover:bg-bg-input disabled:opacity-50">
                  {loadingMore && <Loader2 size={14} className="animate-spin" />}
                  {t("annotations.loadMore")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
