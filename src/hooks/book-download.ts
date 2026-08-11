/**
 * The wire shape of a watched iCloud book download (D-013), mirroring
 * `icloud::download` on the Rust side.
 *
 * Its own file for the same reason `cellular-consent.ts` is: `useBooks.ts`
 * imports `@tauri-apps/api/core` and i18n, so nothing in it can be reached
 * from a plain `node --test` unit test. Everything here is pure, which is what
 * lets the channel name be checked against the backend's spelling.
 * Re-exported from `useBooks.ts` so callers keep one import site.
 */

/** What a watched download is doing — mirrors `DownloadPhase` in `icloud/download.rs`. */
export type BookDownloadPhase = "downloading" | "ready" | "cancelled" | "failed";

/**
 * One event off `book-download-<requestId>`, mirroring `BookDownloadProgress`
 * in `icloud/download.rs`.
 *
 * `percent` is optional because iCloud frequently reports no number for a whole
 * download — a subscriber has to be able to render an indeterminate wait, and
 * cannot treat a missing percentage as zero.
 */
export interface BookDownloadProgress {
  book_id: string;
  phase: BookDownloadPhase;
  percent?: number;
  done: boolean;
  error?: string;
  detail?: string;
}

/**
 * The channel one watched download reports on. Same shape as the backend's
 * `icloud::download::event_name`, and the same subscribe-then-invoke order as
 * the AI streams: the caller mints the id, listens, and only then invokes, so
 * no event can land between the two.
 */
export function bookDownloadEventName(requestId: string): string {
  return `book-download-${requestId}`;
}
