import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Highlight {
  id: string;
  book_id: string;
  cfi_range: string;
  color: string;
  text_content: string | null;
  created_at: number;
  updated_at: number;
}

function notifyHighlightChanged(bookId: string) {
  window.dispatchEvent(new CustomEvent("highlight-changed", { detail: { bookId } }));
}

/**
 * Bookmarks are not a table, a command, or a hook of their own: a bookmark is a
 * `notes` row with `anchor_kind = 'position'`, read and written through
 * `list_notes` / `save_note` / `delete_note` like any other note. The
 * `add_bookmark` / `list_bookmarks` / `remove_bookmark` commands still exist on
 * the backend for the MCP tools that speak that shape; nothing in the UI calls
 * them. See `ReaderNotesPanel`.
 */
export function useHighlights(bookId: string) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Highlight[]>("list_highlights", {
        bookId,
      });
      setHighlights(result);
    } catch (err) {
      console.error("Failed to load highlights:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (cfiRange: string, color?: string, textContent?: string) => {
      const highlight = await invoke<Highlight>("add_highlight", {
        bookId,
        cfiRange,
        color: color || null,
        textContent: textContent || null,
      });
      setHighlights((prev) => [highlight, ...prev]);
      notifyHighlightChanged(bookId);
      return highlight;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    await invoke("remove_highlight", { id });
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    notifyHighlightChanged(bookId);
  }, [bookId]);

  const updateColor = useCallback(async (id: string, color: string) => {
    await invoke("update_highlight_color", { id, color });
    setHighlights((prev) =>
      prev.map((h) => (h.id === id ? { ...h, color } : h))
    );
    notifyHighlightChanged(bookId);
  }, [bookId]);

  return { highlights, refresh, add, remove, updateColor };
}
