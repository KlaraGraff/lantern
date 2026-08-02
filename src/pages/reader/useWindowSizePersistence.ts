import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { platform } from "../../services/platform";

const readerWindow = getCurrentWebviewWindow();

/**
 * Remember how big the reader window was, per book, so reopening that book
 * reopens at the size it was left at.
 *
 * `enabled` is the caller's "this reader is its own window" check, which is
 * already false where there are no windows to size. The `hasWindow` guard is
 * here to say why the hook has nothing to do there (D-005), rather than to
 * catch a case the caller misses.
 */
export function useWindowSizePersistence(bookId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!platform.hasWindow || !enabled || !bookId) return;
    let timer: number | null = null;
    const unlistenPromise = readerWindow.onResized(({ payload }) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const scale = await readerWindow.scaleFactor();
          const logical = payload.toLogical(scale);
          localStorage.setItem(
            `reader-window-${bookId}`,
            JSON.stringify({ width: Math.round(logical.width), height: Math.round(logical.height) }),
          );
        } catch { /* window may have closed */ }
      }, 500);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [bookId, enabled]);
}
