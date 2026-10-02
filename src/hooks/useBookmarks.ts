import { useState, useEffect, useCallback, useRef } from "react";
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
  const [snapshot, setSnapshot] = useState<{ bookId: string; highlights: Highlight[] }>({ bookId, highlights: [] });
  const requestRef = useRef({ bookId, disposed: false, revision: 0 });
  const highlights = snapshot.bookId === bookId ? snapshot.highlights : [];

  const refresh = useCallback(async () => {
    const request = requestRef.current;
    if (request.disposed || request.bookId !== bookId) return;
    const revision = ++request.revision;
    try {
      const result = await invoke<Highlight[]>("list_highlights", { bookId });
      if (!request.disposed && revision === request.revision) {
        setSnapshot({ bookId, highlights: result });
      }
    } catch (err) {
      if (!request.disposed && revision === request.revision) console.error("Failed to load highlights:", err);
    }
  }, [bookId]);

  useEffect(() => {
    const request = requestRef.current;
    request.bookId = bookId;
    request.disposed = false;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (!detail?.bookId || detail.bookId === bookId) void refresh();
    };
    window.addEventListener("highlight-changed", changed);
    void refresh();
    return () => {
      request.disposed = true;
      request.revision += 1;
      window.removeEventListener("highlight-changed", changed);
    };
  }, [bookId, refresh]);

  const add = useCallback(
    async (cfiRange: string, color?: string, textContent?: string) => {
      const highlight = await invoke<Highlight>("add_highlight", {
        bookId,
        cfiRange,
        color: color || null,
        textContent: textContent || null,
      });
      notifyHighlightChanged(bookId);
      return highlight;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    await invoke("remove_highlight", { id });
    notifyHighlightChanged(bookId);
  }, [bookId]);

  const updateColor = useCallback(async (id: string, color: string) => {
    await invoke("update_highlight_color", { id, color });
    notifyHighlightChanged(bookId);
  }, [bookId]);

  return { highlights, refresh, add, remove, updateColor };
}
