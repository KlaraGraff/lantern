import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string | null;
  cover_path: string | null;
  file_path: string;
  // Text-like source files are prepared into a local reader document. Native
  // formats retain their source extension for Foliate's parser selection.
  format: "epub" | "pdf" | "text" | "mobi" | "azw" | "azw3" | "fb2" | "fbz" | "cbz";
  source_format: string | null;
  source_sha256?: string | null;
  render_format: string | null;
  preparation_state: "pending" | "preparing" | "ready" | "failed";
  preparation_error: string | null;
  genre: string | null;
  pages: number | null;
  status: "reading" | "finished" | "unread";
  progress: number;
  current_cfi: string | null;
  created_at: number;
  updated_at: number;
  available: boolean;
  cover_data: string | null;
}

export type BookAvailabilityStatus =
  | "available"
  | "icloud_placeholder"
  | "missing"
  // Only `diagnoseBookFile` can return this: the file is where it should be and
  // still cannot be read. `checkBookAvailable` never looks that closely.
  | "unreadable";

export interface BookAvailability {
  status: BookAvailabilityStatus;
  available: boolean;
}

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

export function useBooks(filter?: string, search?: string, collectionId?: string) {
  const [books, setBooks] = useState<Book[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: filter || null,
        search: search || null,
        collectionId: collectionId || null,
        cursor: null,
        limit: null,
      });
      setBooks(page.books);
      setTotal(page.total);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load books:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, search, collectionId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: filter || null,
        search: search || null,
        collectionId: collectionId || null,
        cursor,
        limit: null,
      });
      setBooks((prev) => [...prev, ...page.books]);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load more books:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filter, search, collectionId, loadingMore]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { books, total, loading, loadingMore, hasMore, loadMore, refresh };
}

/** One file's failure inside a dialog import batch — kept alongside
 * `imported` so a bad file can be reported without the rest of the
 * selection aborting. Mirrors the backend's `ImportFailure`. */
export interface ImportFailure {
  file_name: string;
  error: string;
}

/** Result of `import_book_from_dialog`, which now always resolves the whole
 * file picker selection (one file or many) rather than a single `Book`.
 * Both empty means the user cancelled the picker. */
export interface ImportBatchResult {
  imported: Book[];
  failures: ImportFailure[];
}

async function importFiles(): Promise<ImportBatchResult> {
  return invoke<ImportBatchResult>("import_book_from_dialog");
}

export const importBookDialog = { importFiles };

/** Healthy imports finish in 1-5s; past this, either pdf.js is stalled
 * (PDF_METADATA_TIMEOUT_MS) or the Rust EPUB path is grinding on a large
 * file. Shared so every "still working" hint agrees on the threshold. */
export const IMPORT_SLOW_HINT_MS = 5000;

export async function getBook(id: string): Promise<Book> {
  return invoke<Book>("get_book", { id });
}

export async function deleteBook(id: string, preserveNotes = false): Promise<void> {
  return invoke("delete_book", { id, preserveNotes });
}

/**
 * The `reading_review` job's trigger, shared by every path that can land a
 * book on "finished" — the manual `markFinished` below, and the §2.2
 * auto-finish gate in `updateReadingProgress`. Kept as its own function
 * rather than folded into either caller so the two context bits only the
 * webview knows — the reader's interface language and timezone — travel with
 * it exactly once, regardless of which path produced the finish. The gate,
 * the spend tag and the silence all live in Rust; this side only says "a book
 * was finished, here is where you are".
 *
 * Deliberately not awaited by callers: marking a book finished must not wait
 * on a provider round-trip, and there is nothing to report either way. The
 * catch exists only for the case where the command itself is missing.
 */
function triggerBookFinishedAnalysis(id: string): void {
  void invoke("run_book_finished_analysis", {
    bookId: id,
    language: i18n.language?.startsWith("zh") ? "zh" : "en",
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
  }).catch(() => {});
}

/**
 * The §2.2 auto-finish gate's coverage denominator (how many screens the
 * whole book takes) is computed on the backend from this book's own reading
 * history (`reading_behavior::estimate_total_book_screens`), not passed in
 * from here — see that function's doc comment for the derivation, and for
 * why it returns "skip the check" rather than any fallback number whenever
 * the evidence isn't trustworthy yet, per "宁可漏标，不可错标". When the
 * gate does clear, the backend finishes the book through the same event
 * shape `markFinished` produces and reports it back here, so the caller can
 * run the same finished-book analysis a manual finish would have. Returns
 * that same flag so a caller with local book state (the reader's own
 * `book.status`) can reflect it without waiting for a refetch.
 */
export async function updateReadingProgress(
  id: string,
  progress: number,
  cfi?: string,
): Promise<boolean> {
  const autoFinished = await invoke<boolean>("update_reading_progress", {
    id,
    progress,
    cfi: cfi || null,
  });
  if (autoFinished) triggerBookFinishedAnalysis(id);
  return autoFinished;
}

export async function markFinished(id: string): Promise<void> {
  await invoke("mark_finished", { id });
  triggerBookFinishedAnalysis(id);
}

export async function updateBookStatus(id: string, status: "reading" | "finished" | "unread"): Promise<void> {
  return invoke("update_book_status", { id, status });
}

export async function updateBookMetadata(
  id: string,
  title: string,
  author: string
): Promise<void> {
  return invoke("update_book_metadata", { id, title, author });
}

export async function updateBookCover(id: string, imagePath: string): Promise<void> {
  return invoke("update_book_cover", { id, imagePath });
}

export async function checkBookAvailable(id: string): Promise<BookAvailability> {
  return invoke<BookAvailability>("check_book_available", { id });
}

/**
 * The deep probe, for use once at a failure point — it reads from the file
 * rather than asking the filesystem whether the name resolves. Never put this
 * on a poll; `checkBookAvailable` is the one built for that.
 *
 * `requestId` is what turns an evicted book into a download the caller can
 * watch on `book-download-<requestId>` (D-013) — pass one when a screen is
 * waiting on this book, omit it for a background nudge. It is also what
 * makes the D-016 cellular gate reachable at all: the backend only asks for
 * consent on the watched path, so a caller that wants
 * {@link isCellularConsentError} to ever fire has to pass a request id.
 */
export async function diagnoseBookFile(id: string, requestId?: string): Promise<BookAvailability> {
  return invoke<BookAvailability>("diagnose_book_file", { id, requestId: requestId ?? null });
}

// D-013's channel name and event shape live in `book-download.ts` (pure, no
// i18n import) for the same reason `cellular-consent.ts` does — see that file.
export {
  bookDownloadEventName,
  type BookDownloadPhase,
  type BookDownloadProgress,
} from "./book-download";

// D-016's error code, settings key, and consent predicate live in
// `cellular-consent.ts` (pure, no i18n import) — see that file's doc comment
// for why. Re-exported here so existing callers keep one import site.
export {
  CELLULAR_CONSENT_ERROR,
  CELLULAR_CONSENT_SETTING_KEY,
  isCellularConsentError,
  type CellularDownloadConsent,
} from "./cellular-consent";

/**
 * Retry `diagnoseBookFile` once after the caller has recorded the user's
 * cellular-download answer.
 *
 * Deliberately does not write the setting itself — `save`/`set_setting` is
 * how every other settings row writes, and callers that already hold a
 * `SettingsProps.save` (or an equivalent `set_setting` invoke) should keep
 * using it rather than have this function open a second path to the same
 * row. This only re-runs the probe, which is the part that is easy to get
 * wrong (retrying the *unwatched* probe would silently drop the request id).
 */
export async function retryDiagnoseBookFileAfterConsent(
  id: string,
  requestId: string,
): Promise<BookAvailability> {
  return diagnoseBookFile(id, requestId);
}

export async function retryTextBookPreparation(id: string): Promise<void> {
  return invoke("retry_text_book_preparation", { bookId: id });
}

export async function retryBookConversion(id: string): Promise<void> {
  return invoke("retry_book_conversion", { bookId: id });
}

/** A book whose reader format is EPUB but whose source is a different format
 * (MOBI/AZW3, later scanned PDF) — it is served from a locally converted EPUB. */
export function isConversionBook(book: Book): boolean {
  return (
    book.render_format === "epub" &&
    book.source_format !== null &&
    book.source_format !== "epub"
  );
}

/** Books that must finish background preparation (text conversion or
 * source→EPUB conversion) before the reader can open them. */
export function needsPreparation(book: Book): boolean {
  return book.render_format === "text" || isConversionBook(book);
}

/** True while such a book is not yet ready to open. */
export function isPendingPreparation(book: Book): boolean {
  return needsPreparation(book) && book.preparation_state !== "ready";
}

/** Dispatch a preparation retry to the right backend command by book kind. */
export async function retryPreparation(book: Book): Promise<void> {
  if (isConversionBook(book)) return retryBookConversion(book.id);
  return retryTextBookPreparation(book.id);
}
