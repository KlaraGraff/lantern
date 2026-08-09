import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { platform } from "../../services/platform";
import { READER_FRAME_KEY_PREFIX, type SavedFrame } from "../../utils/openReaderWindow";

const readerWindow = getCurrentWebviewWindow();

const DEBOUNCE_MS = 500;

/** Size and position are written by two independent listeners, so each has to
 *  merge into whatever the other left rather than overwrite the whole record —
 *  otherwise a resize erases the remembered position and a move erases the
 *  remembered size. */
function mergeFrame(bookId: string, patch: Partial<SavedFrame>): void {
  const key = `${READER_FRAME_KEY_PREFIX}${bookId}`;
  let current: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) current = (JSON.parse(raw) as Record<string, unknown>) ?? {};
  } catch {
    current = {};
  }
  localStorage.setItem(key, JSON.stringify({ ...current, ...patch }));
}

/**
 * Remember the reader window's frame, per book, so reopening that book reopens
 * it where and how it was left. Position matters as much as size here: without
 * it, a window the reader dragged somewhere deliberate would be dragged back to
 * the cascade's idea of where it belongs on every open.
 *
 * `enabled` is the caller's "this reader is its own window" check, which is
 * already false where there are no windows to place. The `hasWindow` guard is
 * here to say why the hook has nothing to do there (D-005), rather than to
 * catch a case the caller misses.
 */
export function useWindowFramePersistence(bookId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!platform.hasWindow || !enabled || !bookId) return;

    let resizeTimer: number | null = null;
    let moveTimer: number | null = null;

    const unlistenResized = readerWindow.onResized(({ payload }) => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(async () => {
        try {
          const scale = await readerWindow.scaleFactor();
          const logical = payload.toLogical(scale);
          mergeFrame(bookId, { width: Math.round(logical.width), height: Math.round(logical.height) });
        } catch { /* window may have closed */ }
      }, DEBOUNCE_MS);
    });

    const unlistenMoved = readerWindow.onMoved(({ payload }) => {
      if (moveTimer !== null) window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(async () => {
        try {
          const scale = await readerWindow.scaleFactor();
          const logical = payload.toLogical(scale);
          mergeFrame(bookId, {
            x: Math.round(logical.x),
            y: Math.round(logical.y),
            physicalX: Math.round(payload.x),
            physicalY: Math.round(payload.y),
          });
        } catch { /* window may have closed */ }
      }, DEBOUNCE_MS);
    });

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (moveTimer !== null) window.clearTimeout(moveTimer);
      unlistenResized.then((unlisten) => unlisten()).catch(() => {});
      unlistenMoved.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [bookId, enabled]);
}
