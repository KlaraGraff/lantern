import { useCallback } from "react";
import { useNavigate } from "react-router";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { platform } from "../services/platform";
import { openReaderWindow, readerUrl, type ReaderTarget } from "../utils/openReaderWindow";
import { opensInNewWindow } from "../utils/reader-open-mode";
import { transitionIntoReader } from "../utils/book-transition";

const inStandaloneReader = getCurrentWebviewWindow().label.startsWith("reader-");

/**
 * "Open this book, at this place."
 *
 * The reader is a route in the window you are in (docs/impls/ui-redesign-single-window.md):
 * the library steps aside and the cover grows into the page. A window of its
 * own is something the caller asks for with `target.newWindow` — ⌘-click, the
 * cover's context menu, ⌘↵ in the palette — and only where windows exist
 * (D-005 `hasWindow`). A standalone reader window keeps opening books in
 * windows of their own, since it cannot swap its book for another.
 *
 * A hook rather than a plain function because the in-window half needs the
 * router, and the router is only reachable from inside it.
 */
export function useOpenBook(): (bookId: string, target?: ReaderTarget) => void {
  const navigate = useNavigate();
  return useCallback((bookId: string, target?: ReaderTarget) => {
    if (opensInNewWindow({ hasWindow: platform.hasWindow, inStandaloneReader }, target?.newWindow)) {
      void openReaderWindow(bookId, target);
      return;
    }
    transitionIntoReader(() => { void navigate(readerUrl(bookId, target)); });
  }, [navigate]);
}
