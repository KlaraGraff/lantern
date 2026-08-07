import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Clock, Download, MessageSquareQuote, Pencil, Search, SearchCheck, Undo2 } from "lucide-react";
import { useHighlights } from "../hooks/useBookmarks";
import { useAutoHighlights, type AutoHighlight } from "../hooks/useAutoHighlights";
import { timeAgo } from "../utils/timeAgo";
import { savedHighlightColor } from "./mark-palette";
import HighlightToolbar from "./HighlightToolbar";
import {
  filterHighlightRows,
  mergeHighlightRows,
  type SourceFilter,
} from "./highlight-rows";

interface HighlightsPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
  onExport?: () => void;
}

interface SelectionNote {
  id: string;
  location: string | null;
  content: string;
}

interface SelectionNotePage {
  notes: SelectionNote[];
  next_cursor: string | null;
}

/**
 * A highlight carries only a colour. Text written about the passage is a note
 * anchored at the same range, joined on `location == cfi_range` as an opaque
 * string — the same rule the Annotations page folds by. Notes come back newest
 * first, so the first one at an anchor is the one this panel edits.
 */
function useHighlightNotes(bookId: string) {
  const [notes, setNotes] = useState<Map<string, SelectionNote>>(new Map());

  const refresh = useCallback(async () => {
    const byAnchor = new Map<string, SelectionNote>();
    let cursor: string | null = null;
    try {
      do {
        const page: SelectionNotePage = await invoke<SelectionNotePage>("list_notes", {
          bookId,
          anchorKind: "selection",
          cursor,
          limit: 200,
        });
        for (const note of page.notes) {
          if (note.location && !byAnchor.has(note.location)) byAnchor.set(note.location, note);
        }
        cursor = page.next_cursor;
      } while (cursor);
      setNotes(byAnchor);
    } catch (err) {
      console.error("Failed to load highlight notes:", err);
    }
  }, [bookId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const notifyChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent("note-changed", { detail: { bookId } }));
  }, [bookId]);

  const save = useCallback(async (cfiRange: string, selectedText: string | null, content: string) => {
    const existing = notes.get(cfiRange);
    const saved = await invoke<SelectionNote>("save_note", {
      id: existing?.id ?? null,
      bookId,
      anchorKind: "selection",
      word: null,
      scope: "book",
      location: cfiRange,
      selectedText,
      content,
    });
    setNotes((current) => new Map(current).set(cfiRange, saved));
    notifyChanged();
  }, [bookId, notes, notifyChanged]);

  const remove = useCallback(async (cfiRange: string) => {
    const existing = notes.get(cfiRange);
    if (!existing) return;
    await invoke("delete_note", { id: existing.id });
    setNotes((current) => {
      const next = new Map(current);
      next.delete(cfiRange);
      return next;
    });
    notifyChanged();
  }, [notes, notifyChanged]);

  return { notes, save, remove };
}

interface AutoHighlightRowProps {
  auto: AutoHighlight;
  page: number | null;
  undoPending: boolean;
  onNavigate?: (cfi: string) => void;
  onKeep: () => void;
  onDismiss: () => void;
  onUndo: () => void;
}

/**
 * A row the reader did not draw, and which says so.
 *
 * The swatch is an underline rather than a filled dot because that is how these
 * are drawn in the book — a lookup mark uses the *automatic* marker style — and
 * because a coloured dot would promise a colour that cannot be changed. The
 * quoted text sits a shade back from a real highlight's for the same reason.
 *
 * Dismissing does not remove the row on the spot: it greys in place and offers
 * 「撤销」 for a few seconds, so the undo is where the thing that vanished was.
 */
function AutoHighlightRow({ auto, page, undoPending, onNavigate, onKeep, onDismiss, onUndo }: AutoHighlightRowProps) {
  const { t } = useTranslation();
  const SourceIcon = auto.source === "lookup" ? SearchCheck : MessageSquareQuote;

  if (undoPending) {
    return (
      <div className="flex items-center gap-3 py-3 pl-[18px] pr-4">
        <div className="min-w-0 flex-1 truncate text-[12.5px] text-text-muted">
          {t("bookmarks.highlightsHidden")}
        </div>
        <button
          onClick={onUndo}
          className="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-accent-text hover:bg-accent-bg"
        >
          <Undo2 size={13} />
          {t("common.undo")}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => onNavigate?.(auto.cfi)}
      className="group flex w-full cursor-pointer items-start gap-0 py-3 pl-[18px] pr-4 text-left hover:bg-bg-input"
    >
      <div className="mt-0.5 grid h-4 w-4 shrink-0 items-end justify-center">
        <div className="h-[3px] w-4 rounded-full bg-text-muted/45" />
      </div>
      <div className="ml-3 min-w-0 flex-1">
        <p className="line-clamp-2 text-[13px] leading-5 tracking-[-0.15px] text-text-secondary">
          &ldquo;{auto.text}&rdquo;
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1 text-[11px] tracking-[0.06px] text-text-muted">
            <SourceIcon size={12} />
            {auto.source === "lookup" && auto.label
              ? t("bookmarks.highlightsFromLookup", { word: auto.label })
              : t("bookmarks.highlightsFromChat")}
          </span>
          {page != null && (
            <span className="text-[11px] tracking-[0.06px] text-text-muted">
              {t("bookmarks.page", { page })}
            </span>
          )}
          <span className="flex items-center gap-1 text-[11px] tracking-[0.06px] text-text-muted">
            <Clock size={12} />
            {timeAgo(auto.created_at)}
          </span>
        </div>
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onKeep(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onKeep(); } }}
          className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] font-medium text-accent-text hover:bg-accent-bg"
        >
          {t("bookmarks.highlightsKeep")}
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onDismiss(); } }}
          className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] text-text-muted hover:bg-bg-surface hover:text-text-primary"
        >
          {t("bookmarks.highlightsDismiss")}
        </div>
      </div>
    </button>
  );
}

const SOURCE_FILTERS: readonly { id: SourceFilter; labelKey: string }[] = [
  { id: "all", labelKey: "bookmarks.highlightsAll" },
  { id: "manual", labelKey: "bookmarks.highlightsMine" },
  { id: "auto", labelKey: "bookmarks.highlightsAuto" },
];

/**
 * Was the second half of `BookmarksPanel`, reached through a tab bar nested
 * inside the traces panel's own tab bar. It is a sibling of bookmarks now, not
 * a child of them, so it owns its own file and its own toolbar row.
 *
 * Two kinds of row share the list: ranges the reader drew, and ranges derived
 * from what they looked up or quoted (`useAutoHighlights`). They are one
 * chronological timeline — see `highlight-rows.ts` for why the automatic ones
 * are never sorted into a group of their own — and the source chips narrow it
 * without reordering it.
 *
 * Automatic rows are marked as automatic and left that way: no colour to pick,
 * no note to write, and only two things to do with one. 「留下」 turns it into a
 * real highlight the reader owns; 「不再显示」 hides just that one.
 */
export default function HighlightsPanel({ bookId, onNavigate, getPageFromCfi, onExport }: HighlightsPanelProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceFilter>("all");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingHighlight, setEditingHighlight] = useState<{ id: string; x: number; y: number } | null>(null);
  const { highlights, refresh: refreshHighlights, remove: removeHighlight, updateColor } = useHighlights(bookId);
  const { autoHighlights, undoable, dismiss, undo, promote } = useAutoHighlights(bookId);
  const { notes: highlightNotes, save: saveHighlightNote, remove: removeHighlightNote } = useHighlightNotes(bookId);
  const editingTarget = editingHighlight
    ? highlights.find((h) => h.id === editingHighlight.id) ?? null
    : null;

  const rows = useMemo(
    () => mergeHighlightRows(highlights, autoHighlights),
    [highlights, autoHighlights],
  );
  const visibleRows = useMemo(
    () => filterHighlightRows(rows, { source, color: colorFilter, search }),
    [rows, source, colorFilter, search],
  );
  const undoableAnchors = useMemo(() => new Set(undoable), [undoable]);

  const keep = useCallback(async (anchor: string) => {
    try {
      await promote(anchor);
      await refreshHighlights();
    } catch (err) {
      console.error("Failed to keep automatic highlight:", err);
    }
  }, [promote, refreshHighlights]);

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <div className="flex h-[45px] shrink-0 items-center gap-2 px-3">
        {SOURCE_FILTERS.map((filter) => (
          <button
            key={filter.id}
            onClick={() => {
              setSource(filter.id);
              // A colour left set under 自动 would empty the list and take the
              // control that explains why off screen with it.
              if (filter.id === "auto") setColorFilter(null);
            }}
            className={`h-[26px] shrink-0 cursor-pointer rounded-full px-2.5 text-[12px] font-medium transition-colors ${
              source === filter.id
                ? "bg-accent text-white"
                : "bg-bg-input text-text-muted hover:bg-border"
            }`}
          >
            {t(filter.labelKey)}
          </button>
        ))}
        {/* Colours belong to drawn highlights. Under 自动 there is nothing for
            them to filter, so they leave rather than sit there dead. */}
        {source !== "auto" && Object.entries(savedHighlightColor).map(([name, hex]) => (
          <div
            key={name}
            onClick={() => setColorFilter(colorFilter === name ? null : name)}
            className={`h-[18px] w-[18px] shrink-0 cursor-pointer rounded-full transition-transform ${
              colorFilter === name ? "scale-110 ring-2 ring-accent ring-offset-1 ring-offset-bg-muted" : "hover:scale-110"
            }`}
            style={{ backgroundColor: hex }}
          />
        ))}
        <div className="ml-auto flex h-[28px] min-w-[72px] flex-1 items-center gap-1.5 rounded-md bg-bg-input px-2">
          <Search size={12} className="shrink-0 text-text-muted" />
          <input
            type="text"
            placeholder={t("common.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-placeholder"
          />
        </div>
        <button onClick={onExport} title={t("readerExport.open")} aria-label={t("readerExport.open")} className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-primary">
          <Download size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <p className="mt-8 px-4 text-center text-[13px] text-text-muted">
            {rows.length === 0
              ? t("bookmarks.highlightsEmpty")
              : t("bookmarks.highlightsNoMatch")}
          </p>
        ) : (
          visibleRows.map((row) => row.kind === "auto" ? (
            <AutoHighlightRow
              key={row.key}
              auto={row.auto}
              page={getPageFromCfi?.(row.auto.cfi) ?? null}
              undoPending={undoableAnchors.has(row.auto.anchor)}
              onNavigate={onNavigate}
              onKeep={() => void keep(row.auto.anchor)}
              onDismiss={() => void dismiss(row.auto.anchor)}
              onUndo={() => void undo(row.auto.anchor)}
            />
          ) : (() => {
            const highlight = row.highlight;
            return (
            <button
              key={row.key}
              onClick={() => onNavigate?.(highlight.cfi_range)}
              className="group flex w-full cursor-pointer items-start gap-0 py-3 pl-[18px] pr-4 text-left hover:bg-bg-input"
            >
              <div
                className="mt-0.5 h-4 w-4 shrink-0 rounded-full"
                style={{ backgroundColor: savedHighlightColor[highlight.color] ?? savedHighlightColor.yellow }}
              />
              <div className="ml-3 min-w-0 flex-1">
                {highlight.text_content && (
                  <p className="line-clamp-2 text-[13px] leading-5 tracking-[-0.15px] text-text-primary">
                    &ldquo;{highlight.text_content}&rdquo;
                  </p>
                )}
                <div className="mt-1.5 flex items-center gap-3">
                  {getPageFromCfi && (() => {
                    const page = getPageFromCfi(highlight.cfi_range);
                    return page != null ? (
                      <span className="text-[11px] tracking-[0.06px] text-text-muted">
                        {t("bookmarks.page", { page })}
                      </span>
                    ) : null;
                  })()}
                  <span className="flex items-center gap-1 text-[11px] tracking-[0.06px] text-text-muted">
                    <Clock size={12} />
                    {timeAgo(highlight.created_at)}
                  </span>
                </div>
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setEditingHighlight((current) => (
                    current?.id === highlight.id ? null : { id: highlight.id, x: rect.left, y: rect.top }
                  ));
                }}
                aria-label={t("bookmarks.highlightEditButton")}
                className="rounded p-1 opacity-0 transition-opacity hover:bg-bg-surface group-hover:opacity-100"
              >
                <Pencil size={14} className="text-text-muted" />
              </div>
            </button>
            );
          })())
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 pb-3 pt-[11px]">
        <p className="text-center text-[11px] tracking-[0.06px] text-text-muted">
          {t("bookmarks.highlightCount", { count: visibleRows.length })}
        </p>
      </div>

      {editingTarget && editingHighlight && (
        <HighlightToolbar
          key={editingTarget.id}
          x={editingHighlight.x}
          y={editingHighlight.y}
          color={editingTarget.color}
          note={highlightNotes.get(editingTarget.cfi_range)?.content ?? null}
          onChangeColor={(color) => updateColor(editingTarget.id, color)}
          onSaveNote={(note) => {
            const body = note.trim();
            void (body
              ? saveHighlightNote(editingTarget.cfi_range, editingTarget.text_content, body)
              : removeHighlightNote(editingTarget.cfi_range));
          }}
          onDeleteNote={() => { void removeHighlightNote(editingTarget.cfi_range); setEditingHighlight(null); }}
          onDeleteHighlight={() => { removeHighlight(editingTarget.id); setEditingHighlight(null); }}
          onClose={() => setEditingHighlight(null)}
        />
      )}
    </div>
  );
}
