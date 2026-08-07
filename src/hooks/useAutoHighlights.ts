import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Highlight } from "./useBookmarks";

/**
 * A highlight nobody drew — derived on the backend from a lookup you made or a
 * passage you quoted into a chat. See `commands/auto_highlights.rs`: none of
 * this is stored, so there is nothing to edit and no colour to assign.
 */
export interface AutoHighlight {
  /** Identity across devices, and the only thing 「不再显示」 records. */
  anchor: string;
  book_id: string;
  cfi: string;
  text: string;
  source: "lookup" | "chat";
  /** The looked-up word. Chat quotes have no single word behind them. */
  label: string | null;
  created_at: number;
}

/** How long a dismissed row stays on screen offering its undo. */
const UNDO_WINDOW_MS = 6000;

/**
 * Dismissing is instant on the backend but *not* instant on screen: the row
 * stays where it was, greyed, offering 「撤销」 for a few seconds. A row that
 * vanishes the moment you click takes its own undo affordance with it, and a
 * toast pinned to the top of the window would be far from the list it is
 * talking about.
 *
 * Undo is a write, not a rollback — the backend records "not dismissed" with a
 * fresh timestamp so it beats the dismissal on other devices.
 */
export function useAutoHighlights(bookId: string) {
  const [items, setItems] = useState<AutoHighlight[]>([]);
  const [undoable, setUndoable] = useState<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<AutoHighlight[]>("list_auto_highlights", { bookId }));
    } catch (err) {
      console.error("Failed to load automatic highlights:", err);
    }
  }, [bookId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const clearTimer = useCallback((anchor: string) => {
    const timer = timers.current.get(anchor);
    if (timer) clearTimeout(timer);
    timers.current.delete(anchor);
  }, []);

  // Leaving the tab mid-undo drops the row for good — the dismissal is already
  // written, and only the offer to take it back was ever temporary.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const forget = useCallback((anchor: string) => {
    clearTimer(anchor);
    setUndoable((current) => current.filter((a) => a !== anchor));
    setItems((current) => current.filter((item) => item.anchor !== anchor));
  }, [clearTimer]);

  const dismiss = useCallback(async (anchor: string) => {
    try {
      await invoke("set_auto_highlight_dismissed", { bookId, anchor, dismissed: true });
    } catch (err) {
      console.error("Failed to hide automatic highlight:", err);
      return;
    }
    setUndoable((current) => (current.includes(anchor) ? current : [...current, anchor]));
    clearTimer(anchor);
    timers.current.set(anchor, setTimeout(() => forget(anchor), UNDO_WINDOW_MS));
  }, [bookId, clearTimer, forget]);

  const undo = useCallback(async (anchor: string) => {
    clearTimer(anchor);
    try {
      await invoke("set_auto_highlight_dismissed", { bookId, anchor, dismissed: false });
      setUndoable((current) => current.filter((a) => a !== anchor));
    } catch (err) {
      console.error("Failed to restore automatic highlight:", err);
    }
  }, [bookId, clearTimer]);

  /** 「留下」: the backend writes a real highlight and retires this anchor. */
  const promote = useCallback(async (anchor: string) => {
    const highlight = await invoke<Highlight>("promote_auto_highlight", {
      bookId,
      anchor,
      color: null,
    });
    forget(anchor);
    window.dispatchEvent(new CustomEvent("highlight-changed", { detail: { bookId } }));
    return highlight;
  }, [bookId, forget]);

  return { autoHighlights: items, undoable, refresh, dismiss, undo, promote };
}
