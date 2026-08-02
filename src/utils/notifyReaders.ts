import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { platform } from "../services/platform";

/** Changes a reader has to redraw its marks for. */
export type ReaderNotification = "vocab-changed" | "lookup-record-changed";

export interface ReaderNotificationDetail {
  bookId?: string;
  cfi?: string | null;
}

/**
 * Tell every reader that something it draws has changed.
 *
 * A reader is a page in this window, another OS window, or both, so saying it
 * once takes two mechanisms: a DOM event for the listeners here, and a Tauri
 * event for the windows elsewhere. Both halves used to be written out at each
 * call site, always as a pair — this is that pair, named.
 *
 * Where there is one window (D-005 `hasWindow`) the second half is skipped
 * because there is nowhere for it to go, not to save the work: `getAll()` would
 * return this window, whose listeners the DOM event has already reached.
 */
function fanOut(
  event: ReaderNotification,
  detail: ReaderNotificationDetail,
  matches: (label: string) => boolean,
) {
  window.dispatchEvent(new CustomEvent(event, { detail }));
  if (!platform.hasWindow) return;
  void WebviewWindow.getAll()
    .then((windows) => Promise.all(
      windows
        .filter((readerWindow) => matches(readerWindow.label))
        .map((readerWindow) => emitTo(readerWindow.label, event, detail)),
    ))
    .catch(() => {});
}

/**
 * Notify the readers showing one book. Without a book id there is no window to
 * address, so only this window's listeners hear it — which is what the callers
 * that pass an optional id have always done.
 */
export function notifyReaders(event: ReaderNotification, detail: ReaderNotificationDetail) {
  const label = detail.bookId ? `reader-${detail.bookId}` : null;
  fanOut(event, detail, (candidate) => label !== null && candidate === label);
}

/** Notify every reader, for a change that is not about one book. */
export function notifyAllReaders(event: ReaderNotification) {
  fanOut(event, {}, (label) => label.startsWith("reader-"));
}
