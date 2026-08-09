import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Bookmark,
  BookOpen,
  Download,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Input from "./ui/Input";
import Select from "./ui/Select";
import { useOpenBook } from "../hooks/useOpenBook";
import { savedHighlightColor } from "./mark-palette";

/**
 * One anchor's worth of marking. A highlight, a note, or a highlight with a
 * note written on it — the backend folds the last pair into one row so the
 * same passage never shows up twice.
 *
 * `position` is a place the reader kept: the merged bookmark / free-standing
 * note. Its `content` may be empty, and that is not an unfinished row — it is
 * a bookmark.
 */
interface Annotation {
  id: string;
  highlight_id: string | null;
  note_id: string | null;
  book_id: string | null;
  book_title: string | null;
  anchor_kind: "word" | "selection" | "position";
  normalized_word: string | null;
  scope: "book" | "global" | "detached";
  location: string | null;
  selected_text: string | null;
  color: string | null;
  content: string | null;
  created_at: number;
  updated_at: number;
}

interface AnnotationPage {
  annotations: Annotation[];
  next_cursor: string | null;
  total: number;
}

const PAGE_SIZE = 100;

/**
 * Looked-up words live on the vocabulary page and nowhere else. `mark` is the
 * backend's name for everything but them — see `commands/annotations.rs`.
 */
const KIND = "mark";

type Segment = "today" | "week" | "earlier";

const DAY = 24 * 60 * 60 * 1000;

/**
 * When something was written, coarsely.
 *
 * This page dropped its two date pickers: nobody hunting for the line they
 * drew last week wants to type two dates to find it, and the pickers were the
 * only reason the page ever felt like a database query. What is left is the
 * distinction a reader actually makes — today, recently, a while ago — drawn
 * as separators they scroll past rather than controls they operate.
 */
function segmentOf(when: number, now: Date): Segment {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (when >= startOfToday) return "today";
  // Weeks start on Monday, which is where "本周" puts the boundary.
  const startOfWeek = startOfToday - ((now.getDay() + 6) % 7) * DAY;
  return when >= startOfWeek ? "week" : "earlier";
}

const SEGMENT_LABEL: Record<Segment, string> = {
  today: "notes.today",
  week: "notes.thisWeek",
  earlier: "notes.earlier",
};

export default function AnnotationsContent() {
  const { t, i18n } = useTranslation();
  const openInReader = useOpenBook();
  const [items, setItems] = useState<Annotation[]>([]);
  const [bookCatalog, setBookCatalog] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState("");
  const [bookId, setBookId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const queryPage = useCallback((cursor: string | null, limit = PAGE_SIZE) => invoke<AnnotationPage>("list_annotations", {
    bookId: bookId || null,
    kind: KIND,
    search: search.trim() || null,
    updatedAfter: null,
    updatedBefore: null,
    cursor,
    limit,
  }), [bookId, search]);

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
      rememberBooks(page);
    } finally {
      setLoading(false);
    }
  }, [queryPage, rememberBooks]);

  // The book dropdown has to list every book that ever received a mark, not
  // only the ones on the first page of the current filter.
  useEffect(() => {
    invoke<AnnotationPage>("list_annotations", {
      bookId: null, kind: KIND, search: null, updatedAfter: null,
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

  // Opening the editor lands the caret after what is already written, so
  // typing continues the note instead of pushing in front of it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editingId || !editor) return;
    editor.focus();
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }, [editingId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await queryPage(nextCursor);
      setItems((current) => [...current, ...page.annotations]);
      setNextCursor(page.next_cursor);
      setTotal(page.total);
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
      ["type", "highlighted", "scope", "book", "source_text", "note", "updated_at"],
      ...all.map((item) => [
        item.anchor_kind, item.highlight_id ? "1" : "0", item.scope, item.book_title,
        item.selected_text, item.content,
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

  const filtersActive = Boolean(search.trim() || bookId);

  const clearFilters = () => {
    setSearch("");
    setBookId("");
  };

  const startEditing = (item: Annotation) => {
    setConfirmingId(null);
    setEditingId(item.id);
    setDraft(item.content ?? "");
  };

  const stopEditing = () => {
    setEditingId(null);
    setDraft("");
  };

  /**
   * Commits what is in the editor, on the way out of it.
   *
   * Every note is a `notes` row — a highlight carries no text of its own.
   * Writing on a highlight therefore saves a note anchored at the same range
   * (`location == cfi_range`), which is exactly what the union folds back into
   * this one item on the next read.
   *
   * Clearing the text deletes the note but never the row it was written on: a
   * highlight is still a highlight with nothing said about it, and a kept place
   * with its text removed is a bookmark again rather than nothing at all.
   */
  const commit = async (item: Annotation) => {
    if (saving) return;
    const content = draft.trim();
    if (content === (item.content ?? "")) {
      stopEditing();
      return;
    }
    setSaving(true);
    try {
      if (!content && item.note_id && item.anchor_kind !== "position") {
        await invoke("delete_note", { id: item.note_id });
      } else if (content || item.note_id) {
        await invoke("save_note", {
          id: item.note_id,
          bookId: item.book_id,
          anchorKind: item.anchor_kind,
          word: null,
          scope: item.note_id ? item.scope : "book",
          location: item.location,
          selectedText: item.anchor_kind === "position" ? null : item.selected_text,
          content,
        });
      }
      stopEditing();
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

  const now = new Date();
  let lastSegment: Segment | null = null;

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
            <span className="text-[12px] text-text-muted">{t("annotations.count", { count: total })}</span>
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
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-page">
        {loading ? (
          <p className="text-[13px] text-text-muted">{t("home.loading")}</p>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-accent-bg text-accent-text">
              {filtersActive ? <Search size={22} /> : <Bookmark size={22} />}
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
          <div className="mx-auto max-w-[920px]">
            {items.map((item) => {
              const segment = segmentOf(item.updated_at, now);
              const opensSegment = segment !== lastSegment;
              lastSegment = segment;
              const isPlace = item.anchor_kind === "position";
              const editing = editingId === item.id;
              return (
                <div key={item.id}>
                  {opensSegment && (
                    <p className="pb-1.5 pt-5 text-[11px] font-medium tracking-[0.4px] text-text-muted first:pt-0">
                      {t(SEGMENT_LABEL[segment])}
                    </p>
                  )}
                  <article className="flex items-start gap-3 border-t border-border-light py-[18px]">
                    {/* The only thing that says what kind of mark this is, and
                        it says it without a word. */}
                    <div className="mt-0.5 flex w-4 shrink-0 justify-center">
                      {isPlace ? (
                        <Bookmark size={15} className="text-text-muted" />
                      ) : (
                        <span
                          className="block h-[30px] w-[4px] rounded-full"
                          style={{ backgroundColor: item.color ? savedHighlightColor[item.color] ?? savedHighlightColor.yellow : "var(--color-border)" }}
                        />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      {isPlace ? (
                        <p className="text-[13px] font-medium text-text-primary">{t("notes.keptPlace")}</p>
                      ) : item.selected_text ? (
                        <p className="whitespace-pre-wrap break-words font-serif text-[13px] leading-[1.75] text-text-body">
                          {item.selected_text}
                        </p>
                      ) : null}

                      {editing ? (
                        <div className="mt-2">
                          <textarea
                            ref={editorRef}
                            rows={4}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => commit(item).catch(() => setSaving(false))}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") { event.preventDefault(); stopEditing(); }
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); }
                            }}
                            className="w-full resize-y rounded-lg border border-accent/40 bg-bg-surface px-3 py-2.5 text-[13px] leading-[1.7] text-text-primary outline-none focus:border-accent"
                          />
                          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-accent-text">
                            {saving && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />}
                            {t("annotations.editing")}
                          </p>
                        </div>
                      ) : item.content ? (
                        // The body is the edit entry point. There is no pencil:
                        // the thing you want to change is the thing you click.
                        <button type="button" onClick={() => startEditing(item)} className="mt-2 block w-full text-left">
                          <span className="block whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-text-secondary">{item.content}</span>
                        </button>
                      ) : (
                        <button type="button" onClick={() => startEditing(item)} className="mt-2 block text-left text-[11.5px] text-text-placeholder hover:text-accent-text">
                          {t("annotations.noNote")}
                        </button>
                      )}

                      <p className="mt-1.5 text-[11px] text-text-muted">
                        {item.book_title || (item.scope === "detached" ? t("notes.detachedSource") : t("common.unknownBook"))} · {formatter.format(item.updated_at)}
                      </p>

                      {confirmingId === item.id && (
                        <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger-text" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-medium text-danger-text">
                              {t(isPlace ? "notes.deletePlaceTitle" : "notes.deleteMarkTitle")}
                            </p>
                            <p className="mt-1 text-[10.5px] leading-[1.55] text-danger-text/80">
                              {t(isPlace ? "notes.deletePlaceBody" : "notes.deleteMarkBody")}
                            </p>
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
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {!item.content && !editing && (
                        <button type="button" onClick={() => startEditing(item)} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-text-secondary hover:border-accent/30 hover:bg-accent-bg hover:text-accent-text">
                          <Plus size={12} />
                          {t("notes.writeSomething")}
                        </button>
                      )}
                      {item.book_id && item.location && (
                        <button type="button" onClick={() => openInReader(item.book_id!, { cfi: item.location! })} title={t("annotations.locate")} aria-label={t("annotations.locate")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text">
                          <BookOpen size={14} />
                        </button>
                      )}
                      <button type="button" onClick={() => { stopEditing(); setConfirmingId(item.id); }} title={t("common.delete")} aria-label={t("common.delete")} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                </div>
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
