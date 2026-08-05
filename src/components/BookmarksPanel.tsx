import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkPlus, Trash2, Pencil, Clock, Search, Download } from "lucide-react";
import { useBookmarks, useHighlights } from "../hooks/useBookmarks";
import { timeAgo } from "../utils/timeAgo";
import { savedHighlightColor } from "./mark-palette";
import HighlightToolbar from "./HighlightToolbar";

interface BookmarksPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getCurrentCfi?: () => string | null;
  getCurrentLabel?: () => string;
  getPageFromCfi?: (cfi: string) => number | null;
  onExport?: () => void;
}

type Tab = "bookmarks" | "highlights";

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

export default function BookmarksPanel({ bookId, onNavigate, getCurrentCfi, getCurrentLabel, getPageFromCfi, onExport }: BookmarksPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("bookmarks");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingHighlight, setEditingHighlight] = useState<{ id: string; x: number; y: number } | null>(null);
  const { bookmarks, add: addBookmark, remove: removeBookmark } = useBookmarks(bookId);
  const { highlights, remove: removeHighlight, updateColor } = useHighlights(bookId);
  const { notes: highlightNotes, save: saveHighlightNote, remove: removeHighlightNote } = useHighlightNotes(bookId);
  const editingTarget = editingHighlight
    ? highlights.find((h) => h.id === editingHighlight.id) ?? null
    : null;

  const handleAddBookmark = async () => {
    const cfi = getCurrentCfi?.();
    if (!cfi) return;
    const label = getCurrentLabel?.() || "Bookmark";
    await addBookmark(cfi, label);
  };

  const filteredHighlights = highlights.filter((h) => {
    if (colorFilter && h.color !== colorFilter) return false;
    if (search && h.text_content && !h.text_content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab("bookmarks")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "bookmarks"
              ? "text-text-primary border-b-2 border-accent"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          {t("bookmarks.tab.bookmarks")}
        </button>
        <button
          onClick={() => setTab("highlights")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "highlights"
              ? "text-text-primary border-b-2 border-accent"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          {t("bookmarks.tab.highlights")}
        </button>
      </div>

      {/* Bookmarks tab */}
      {tab === "bookmarks" && (
        <>
          {/* Bookmark header */}
          <div className="flex items-center justify-end px-4 h-[45px] shrink-0">
            <button
              onClick={handleAddBookmark}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-bg-input hover:bg-border cursor-pointer"
            >
              <BookmarkPlus size={16} className="text-text-primary" />
              <span className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
                {t("bookmarks.saved")}
              </span>
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            {bookmarks.length === 0 ? (
              <p className="text-[13px] text-text-muted text-center mt-8 px-4">
                {t("bookmarks.empty")}
              </p>
            ) : (
              bookmarks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  onClick={() => onNavigate?.(bookmark.cfi)}
                  className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left border-l-2 border-transparent hover:bg-bg-input group cursor-pointer"
                >
                  <Bookmark size={16} className="shrink-0 mt-0.5 text-text-muted" />
                  <div className="ml-3 min-w-0 flex-1">
                    <span className="block text-[14px] text-text-primary tracking-[-0.15px] leading-5 truncate">
                      {bookmark.label || "Bookmark"}
                    </span>
                    <div className="flex items-center gap-3 mt-1.5">
                      {getPageFromCfi && (() => {
                        const page = getPageFromCfi(bookmark.cfi);
                        return page != null ? (
                          <span className="text-[11px] text-text-muted tracking-[0.06px]">
                            {t("bookmarks.page", { page })}
                          </span>
                        ) : null;
                      })()}
                      <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                        <Clock size={12} />
                        {timeAgo(bookmark.created_at)}
                      </span>
                    </div>
                  </div>
                  <div
                    onClick={(e) => { e.stopPropagation(); removeBookmark(bookmark.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface transition-opacity"
                  >
                    <Trash2 size={14} className="text-text-muted" />
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
            <p className="text-[11px] text-text-muted tracking-[0.06px] text-center">
              {t("bookmarks.count", { count: bookmarks.length })}
            </p>
          </div>
        </>
      )}

      {/* Highlights tab */}
      {tab === "highlights" && (
        <>
          {/* Filter bar */}
          <div className="flex items-center gap-2 px-4 h-[45px] shrink-0">
            <button
              onClick={() => setColorFilter(null)}
              className={`px-2.5 h-[26px] rounded-full text-[12px] font-medium cursor-pointer transition-colors ${
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
                className={`w-[18px] h-[18px] rounded-full cursor-pointer transition-transform ${
                  colorFilter === name ? "ring-2 ring-offset-1 ring-accent ring-offset-bg-muted scale-110" : "hover:scale-110"
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            <div className="flex-1 flex items-center gap-1.5 ml-auto h-[28px] px-2 rounded-md bg-bg-input">
              <Search size={12} className="text-text-muted shrink-0" />
              <input
                type="text"
                placeholder={t("common.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder"
              />
            </div>
            <button onClick={onExport} title={t("readerExport.open")} aria-label={t("readerExport.open")} className="grid size-8 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-primary">
              <Download size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            {filteredHighlights.length === 0 ? (
              <p className="text-[13px] text-text-muted text-center mt-8 px-4">
                {highlights.length === 0
                  ? t("bookmarks.highlightsEmpty")
                  : t("bookmarks.highlightsNoMatch")}
              </p>
            ) : (
              filteredHighlights.map((highlight) => (
                <button
                  key={highlight.id}
                  onClick={() => onNavigate?.(highlight.cfi_range)}
                  className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left hover:bg-bg-input group cursor-pointer"
                >
                  <div
                    className="w-4 h-4 rounded-full shrink-0 mt-0.5"
                    style={{ backgroundColor: savedHighlightColor[highlight.color] ?? savedHighlightColor.yellow }}
                  />
                  <div className="ml-3 min-w-0 flex-1">
                    {highlight.text_content && (
                      <p className="text-[13px] text-text-primary tracking-[-0.15px] leading-5 line-clamp-2">
                        &ldquo;{highlight.text_content}&rdquo;
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      {getPageFromCfi && (() => {
                        const page = getPageFromCfi(highlight.cfi_range);
                        return page != null ? (
                          <span className="text-[11px] text-text-muted tracking-[0.06px]">
                            {t("bookmarks.page", { page })}
                          </span>
                        ) : null;
                      })()}
                      <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
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
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface transition-opacity"
                  >
                    <Pencil size={14} className="text-text-muted" />
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
            <p className="text-[11px] text-text-muted tracking-[0.06px] text-center">
              {t("bookmarks.highlightCount", { count: filteredHighlights.length })}
            </p>
          </div>
        </>
      )}

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
