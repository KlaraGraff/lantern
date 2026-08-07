import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Clock, Download, Pencil, Search } from "lucide-react";
import { useHighlights } from "../hooks/useBookmarks";
import { timeAgo } from "../utils/timeAgo";
import { savedHighlightColor } from "./mark-palette";
import HighlightToolbar from "./HighlightToolbar";

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

/**
 * Was the second half of `BookmarksPanel`, reached through a tab bar nested
 * inside the traces panel's own tab bar. It is a sibling of bookmarks now, not
 * a child of them, so it owns its own file and its own toolbar row.
 *
 * Ordering is `list_highlights`' own — newest first — and no filter reorders
 * it. Filtering narrows the list; it never promotes one kind of highlight above
 * another.
 */
export default function HighlightsPanel({ bookId, onNavigate, getPageFromCfi, onExport }: HighlightsPanelProps) {
  const { t } = useTranslation();
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingHighlight, setEditingHighlight] = useState<{ id: string; x: number; y: number } | null>(null);
  const { highlights, remove: removeHighlight, updateColor } = useHighlights(bookId);
  const { notes: highlightNotes, save: saveHighlightNote, remove: removeHighlightNote } = useHighlightNotes(bookId);
  const editingTarget = editingHighlight
    ? highlights.find((h) => h.id === editingHighlight.id) ?? null
    : null;

  const filteredHighlights = highlights.filter((h) => {
    if (colorFilter && h.color !== colorFilter) return false;
    if (search && h.text_content && !h.text_content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <div className="flex h-[45px] shrink-0 items-center gap-2 px-3">
        <button
          onClick={() => setColorFilter(null)}
          className={`h-[26px] cursor-pointer rounded-full px-2.5 text-[12px] font-medium transition-colors ${
            colorFilter === null
              ? "bg-accent text-white"
              : "bg-bg-input text-text-muted hover:bg-border"
          }`}
        >
          {t("bookmarks.highlightsAll")}
        </button>
        {Object.entries(savedHighlightColor).map(([name, hex]) => (
          <div
            key={name}
            onClick={() => setColorFilter(colorFilter === name ? null : name)}
            className={`h-[18px] w-[18px] cursor-pointer rounded-full transition-transform ${
              colorFilter === name ? "scale-110 ring-2 ring-accent ring-offset-1 ring-offset-bg-muted" : "hover:scale-110"
            }`}
            style={{ backgroundColor: hex }}
          />
        ))}
        <div className="ml-auto flex h-[28px] flex-1 items-center gap-1.5 rounded-md bg-bg-input px-2">
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
        {filteredHighlights.length === 0 ? (
          <p className="mt-8 px-4 text-center text-[13px] text-text-muted">
            {highlights.length === 0
              ? t("bookmarks.highlightsEmpty")
              : t("bookmarks.highlightsNoMatch")}
          </p>
        ) : (
          filteredHighlights.map((highlight) => (
            <button
              key={highlight.id}
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
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 pb-3 pt-[11px]">
        <p className="text-center text-[11px] tracking-[0.06px] text-text-muted">
          {t("bookmarks.highlightCount", { count: filteredHighlights.length })}
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
