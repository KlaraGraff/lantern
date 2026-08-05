import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  BookOpen,
  Download,
  FileText,
  Highlighter,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Input from "./ui/Input";
import Select from "./ui/Select";
import { useOpenBook } from "../hooks/useOpenBook";

/**
 * One anchor's worth of marking. A highlight, a note, or a highlight with a
 * note written on it — the backend folds the last pair into one row so the
 * same passage never shows up twice.
 */
interface Annotation {
  id: string;
  highlight_id: string | null;
  note_id: string | null;
  book_id: string | null;
  book_title: string | null;
  anchor_kind: "word" | "selection";
  normalized_word: string | null;
  scope: "book" | "global" | "detached";
  location: string | null;
  selected_text: string | null;
  color: string | null;
  content: string | null;
  created_at: number;
  updated_at: number;
}

interface AnnotationCounts {
  all: number;
  highlights: number;
  with_notes: number;
  words: number;
  selections: number;
  bare_highlights: number;
}

interface AnnotationPage {
  annotations: Annotation[];
  next_cursor: string | null;
  total: number;
  bare_highlights: number;
  counts: AnnotationCounts;
}

type KindFilter = "" | "highlight" | "with_note" | "word" | "selection";

const PAGE_SIZE = 100;
const EMPTY_COUNTS: AnnotationCounts = {
  all: 0, highlights: 0, with_notes: 0, words: 0, selections: 0, bare_highlights: 0,
};

export default function AnnotationsContent({ onOpenVocab }: { onOpenVocab?: (word: string) => void }) {
  const { t, i18n } = useTranslation();
  const openInReader = useOpenBook();
  const [items, setItems] = useState<Annotation[]>([]);
  const [bookCatalog, setBookCatalog] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState("");
  const [bookId, setBookId] = useState("");
  const [kind, setKind] = useState<KindFilter>("");
  const [updatedAfter, setUpdatedAfter] = useState("");
  const [updatedBefore, setUpdatedBefore] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [bare, setBare] = useState(0);
  const [counts, setCounts] = useState<AnnotationCounts>(EMPTY_COUNTS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const dateBoundary = (value: string, endOfDay = false) => {
    if (!value) return null;
    const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  };

  const queryPage = useCallback((cursor: string | null, limit = PAGE_SIZE) => invoke<AnnotationPage>("list_annotations", {
    bookId: bookId || null,
    kind: kind || null,
    search: search.trim() || null,
    updatedAfter: dateBoundary(updatedAfter),
    updatedBefore: dateBoundary(updatedBefore, true),
    cursor,
    limit,
  }), [bookId, kind, search, updatedAfter, updatedBefore]);

  const rememberBooks = useCallback((page: AnnotationPage) => {
    setBookCatalog((current) => {
      const next = new Map(current);
      for (const item of page.annotations) {
        if (item.book_id) next.set(item.book_id, item.book_title || t("common.unknownBook"));
      }
      return next;
    });
  }, [t]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await queryPage(null);
      setItems(page.annotations);
      setNextCursor(page.next_cursor);
      setTotal(page.total);
      setBare(page.bare_highlights);
      setCounts(page.counts);
      rememberBooks(page);
    } finally {
      setLoading(false);
    }
  }, [queryPage, rememberBooks]);

  // The book dropdown has to list every book that ever received a mark, not
  // only the ones on the first page of the current filter.
  useEffect(() => {
    invoke<AnnotationPage>("list_annotations", {
      bookId: null, kind: null, search: null, updatedAfter: null,
      updatedBefore: null, cursor: null, limit: 500,
    })
      .then((page) => {
        const next = new Map<string, string>();
        for (const item of page.annotations) {
          if (item.book_id) next.set(item.book_id, item.book_title || t("common.unknownBook"));
        }
        setBookCatalog(next);
      })
      .catch(() => {});
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => refresh().catch(() => {}), 180);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await queryPage(nextCursor);
      setItems((current) => [...current, ...page.annotations]);
      setNextCursor(page.next_cursor);
      setTotal(page.total);
      setBare(page.bare_highlights);
      setCounts(page.counts);
      rememberBooks(page);
    } finally {
      setLoadingMore(false);
    }
  };

  const downloadCsv = async () => {
    const all: Annotation[] = [];
    let cursor: string | null = null;
    do {
      const page = await queryPage(cursor, 500);
      all.push(...page.annotations);
      cursor = page.next_cursor;
    } while (cursor);
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["type", "highlighted", "scope", "book", "source_text", "word", "note", "updated_at"],
      ...all.map((item) => [
        item.anchor_kind, item.highlight_id ? "1" : "0", item.scope, item.book_title,
        item.selected_text, item.normalized_word, item.content,
        new Date(item.updated_at).toISOString(),
      ]),
    ];
    const href = URL.createObjectURL(new Blob([`\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "lantern-annotations.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const bookOptions = useMemo(() => [
    { value: "", label: t("notes.filters.allBooks") },
    ...Array.from(bookCatalog, ([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, i18n.language)),
  ], [bookCatalog, i18n.language, t]);

  const formatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    year: "numeric", month: "short", day: "numeric",
  }), [i18n.language]);

  const filtersActive = Boolean(search.trim() || bookId || kind || updatedAfter || updatedBefore);

  const clearFilters = () => {
    setSearch("");
    setBookId("");
    setKind("");
    setUpdatedAfter("");
    setUpdatedBefore("");
  };

  const startEditing = (item: Annotation) => {
    setConfirmingId(null);
    setEditingId(item.id);
    setDraft(item.content ?? "");
  };

  /**
   * Every note is a `notes` row — a highlight carries no text of its own.
   * Writing on a highlight therefore saves a note anchored at the same range
   * (`location == cfi_range`), which is exactly what the union folds back into
   * this one item on the next read.
   */
  const saveDraft = async (item: Annotation) => {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      await invoke("save_note", {
        id: item.note_id,
        bookId: item.book_id,
        anchorKind: item.anchor_kind,
        word: item.normalized_word,
        scope: item.note_id ? item.scope : "book",
        location: item.location,
        selectedText: item.selected_text,
        content,
      });
      setEditingId(null);
      setDraft("");
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async (item: Annotation) => {
    if (item.note_id) await invoke("delete_note", { id: item.note_id });
    if (item.highlight_id) await invoke("remove_highlight", { id: item.highlight_id });
    setConfirmingId(null);
    await refresh();
  };

  const pills: { value: KindFilter; label: string; count: number; icon?: React.ReactNode }[] = [
    { value: "", label: t("annotations.filters.all"), count: counts.all },
    { value: "highlight", label: t("annotations.filters.highlights"), count: counts.highlights, icon: <Highlighter size={12} /> },
    { value: "with_note", label: t("annotations.filters.withNotes"), count: counts.with_notes, icon: <FileText size={12} /> },
    { value: "word", label: t("annotations.filters.words"), count: counts.words },
    { value: "selection", label: t("annotations.filters.selections"), count: counts.selections },
  ];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-surface">
      <header className="relative shrink-0 border-b border-border px-page pb-5 pt-titlebar">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-titlebar" />
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold text-text-primary">{t("annotations.title")}</h1>
            <p className="mt-1 text-[13px] text-text-muted">{t("annotations.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-text-muted">
              {bare > 0
                ? t("annotations.countWithBare", { total, bare })
                : t("annotations.count", { count: total })}
            </span>
            <button type="button" onClick={() => downloadCsv().catch(() => {})} title={t("annotations.export")} aria-label={t("annotations.export")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"><Download size={15} /></button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            icon={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("annotations.search")}
            className="min-w-[280px] flex-1"
          />
          <Select className="w-[180px]" value={bookId} onChange={setBookId} options={bookOptions} />
          <label className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-bg-input px-2 text-[11px] text-text-muted">
            {t("notes.filters.from")}
            <input type="date" value={updatedAfter} max={updatedBefore || undefined} onChange={(event) => setUpdatedAfter(event.target.value)} className="bg-transparent text-[12px] text-text-secondary outline-none" />
          </label>
          <label className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-bg-input px-2 text-[11px] text-text-muted">
            {t("notes.filters.to")}
            <input type="date" value={updatedBefore} min={updatedAfter || undefined} onChange={(event) => setUpdatedBefore(event.target.value)} className="bg-transparent text-[12px] text-text-secondary outline-none" />
          </label>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-page py-2.5">
        {pills.map((pill) => (
          <button
            key={pill.value || "all"}
            type="button"
            onClick={() => setKind(pill.value)}
            aria-pressed={kind === pill.value}
            className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium ${
              kind === pill.value
                ? "border-accent/25 bg-accent-bg text-accent-text"
                : "border-border bg-bg-surface text-text-secondary hover:bg-bg-input"
            }`}
          >
            {pill.icon}
            {pill.label}
            <span className={kind === pill.value ? "text-[10.5px] text-accent-text" : "text-[10.5px] text-text-muted"}>{pill.count}</span>
          </button>
        ))}
        <span className="ml-auto hidden text-[10.5px] text-text-muted lg:block">{t("annotations.filters.hint")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-page">
        {loading ? (
          <p className="text-[13px] text-text-muted">{t("home.loading")}</p>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-accent-bg text-accent-text">
              {filtersActive ? <Search size={22} /> : <Highlighter size={22} />}
            </div>
            <p className="text-[14px] font-medium text-text-secondary">
              {filtersActive ? t("annotations.noResult") : t("annotations.empty")}
            </p>
            <p className="max-w-[380px] text-[12px] leading-[1.7] text-text-muted">
              {filtersActive ? t("annotations.noResultHint") : t("annotations.emptyHint")}
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
              const hasNote = Boolean(item.content);
              const isWord = item.anchor_kind === "word";
              return (
                <article key={item.id} className="py-[18px] first:pt-0">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {isWord && item.normalized_word && (
                          <p className="break-words text-[13px] font-semibold text-text-primary">{item.normalized_word}</p>
                        )}
                        {item.highlight_id && (
                          <span className="flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                            <Highlighter size={10} />
                            {t("annotations.chip.highlight")}
                          </span>
                        )}
                        {hasNote && (
                          <span className="rounded-sm bg-link/10 px-1.5 py-0.5 text-[10px] text-link">
                            {t("annotations.chip.hasNote")}
                          </span>
                        )}
                        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${isWord ? "bg-accent-bg text-accent-text" : "bg-bg-input text-text-muted"}`}>
                          {t(isWord ? "annotations.chip.word" : "annotations.chip.selection")}
                        </span>
                        {item.scope === "global" ? (
                          <span className="rounded-sm bg-accent-bg px-1.5 py-0.5 text-[10px] text-accent-text">
                            {t("learningCard.notes.scope.global")}
                          </span>
                        ) : item.scope === "detached" ? (
                          <span className="rounded-sm bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                            {t("learningCard.notes.scope.detached")}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1.5 text-[11px] text-text-muted">
                        {item.book_title || (item.scope === "detached" ? t("notes.detachedSource") : t("common.unknownBook"))} · {formatter.format(item.updated_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!hasNote && item.highlight_id && editingId !== item.id ? (
                        <button type="button" onClick={() => startEditing(item)} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-text-secondary hover:border-accent/30 hover:bg-accent-bg hover:text-accent-text">
                          <Plus size={12} />
                          {t("annotations.addNote")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => startEditing(item)} title={t("common.edit")} aria-label={t("common.edit")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text">
                          <Pencil size={14} />
                        </button>
                      )}
                      {item.book_id && item.location && (
                        <button type="button" onClick={() => openInReader(item.book_id!, { cfi: item.location! })} title={t("annotations.locate")} aria-label={t("annotations.locate")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text">
                          <BookOpen size={14} />
                        </button>
                      )}
                      <button type="button" onClick={() => { setEditingId(null); setConfirmingId(item.id); }} title={t("common.delete")} aria-label={t("common.delete")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {item.selected_text && !isWord && (
                    <p className="mt-2.5 whitespace-pre-wrap break-words border-l-[3px] border-amber-400/70 py-2 pl-3 font-serif text-[13px] leading-[1.75] text-text-body">
                      {item.selected_text}
                    </p>
                  )}

                  {hasNote ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-text-secondary">{item.content}</p>
                  ) : editingId === item.id ? null : (
                    <p className="mt-2 text-[11.5px] text-text-placeholder">{t("annotations.noNote")}</p>
                  )}

                  {isWord && item.normalized_word && onOpenVocab && (
                    <button type="button" onClick={() => onOpenVocab(item.normalized_word!)} className="mt-2.5 flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-text-secondary hover:border-accent/30 hover:bg-accent-bg hover:text-accent-text">
                      <Type size={12} />
                      {t("annotations.viewInVocab")}
                    </button>
                  )}

                  {editingId === item.id && (
                    <div className="mt-2.5">
                      <textarea
                        autoFocus
                        rows={4}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className="w-full resize-y rounded-lg border border-accent/40 bg-bg-surface px-3 py-2.5 text-[13px] leading-[1.7] text-text-primary outline-none focus:border-accent"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        {item.book_title && (
                          <span className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-text-secondary">
                            <BookOpen size={12} />
                            {t("annotations.scopeBook", { book: item.book_title })}
                          </span>
                        )}
                        <div className="flex-1" />
                        <button type="button" onClick={() => { setEditingId(null); setDraft(""); }} className="h-8 rounded-md px-3 text-[12px] text-text-muted hover:bg-bg-input">
                          {t("common.cancel")}
                        </button>
                        <button type="button" disabled={!draft.trim() || saving} onClick={() => saveDraft(item).catch(() => setSaving(false))} className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-white disabled:opacity-45">
                          {saving && <Loader2 size={12} className="animate-spin" />}
                          {saving ? t("readerNotes.saving") : t("common.save")}
                        </button>
                      </div>
                    </div>
                  )}

                  {confirmingId === item.id && (
                    <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger-text" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-danger-text">
                          {t(item.highlight_id ? "annotations.delete.highlightTitle" : "annotations.delete.noteTitle")}
                        </p>
                        {item.highlight_id && (
                          <p className="mt-1 text-[10.5px] leading-[1.55] text-danger-text/80">
                            {t(hasNote ? "annotations.delete.highlightWithNoteBody" : "annotations.delete.highlightBody")}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 self-center">
                        <button type="button" onClick={() => setConfirmingId(null)} className="h-7 rounded-md border border-danger-border bg-bg-surface px-2.5 text-[11px] text-danger-text">
                          {t("common.cancel")}
                        </button>
                        <button type="button" onClick={() => deleteItem(item).catch(() => {})} className="h-7 rounded-md bg-danger px-2.5 text-[11px] text-white">
                          {t("annotations.delete.confirm")}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
            {nextCursor && (
              <div className="flex justify-center py-5">
                <button type="button" disabled={loadingMore} onClick={() => loadMore().catch(() => {})} className="flex h-9 items-center gap-2 rounded-md border border-border px-3.5 text-[12px] text-text-muted hover:bg-bg-input disabled:opacity-50">
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
