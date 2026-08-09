import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * `pending` is also what a book with no row at all reports. `too_short` and
 * `unsupported` are inherited from the difficulty pass rather than decided
 * again — both count the same word list, so they have to agree about whether
 * there is one.
 */
export type CoverageStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "too_short"
  | "unsupported";

/** Mirrors the backend's `BookReaderCoverage` (serde `rename_all = "camelCase"`). */
export interface BookReaderCoverage {
  bookId: string;
  status: CoverageStatus;
  totalTokens: number;
  distinctWords: number;
  masteredTokens: number;
  familiarTokens: number;
  nameTokens: number;
  unknownTokens: number;
  nameWords: number;
  unknownWords: number;
  masteredForms: number;
  familiarForms: number;
  baselineBooks: number;
  /** RFC-3339 UTC: which vocabulary profile these numbers were computed from. */
  profileAt: string | null;
  sourceSha256: string | null;
  computedAt: string | null;
  error: string | null;
  /** The book's file changed after these numbers were computed. */
  stale: boolean;
}

/** Mirrors the backend's `VocabProfileSummary`. */
export interface VocabProfileSummary {
  booksRead: number;
  singleBookTitle: string | null;
  /** Percent, 0–100. */
  singleBookProgress: number | null;
  exposureTokens: number;
  exposureWords: number;
  lookupRecords: number;
  lookupDays: number;
  vocabWords: number;
  reviewedWords: number;
  masteredForms: number;
  familiarForms: number;
  /** Epoch milliseconds. */
  updatedAt: number | null;
}

/** Mirrors the backend's `UnknownWord`. */
export interface UnknownWord {
  word: string;
  tokens: number;
  gloss: string | null;
  encounters: number;
  lookups: number;
  familiar: boolean;
}

/** How far the scan has got, in running words of the book (05). */
export interface CoverageProgress {
  scannedTokens: number;
  totalTokens: number;
}

/** Mirrors the backend's `ShelfCoverage` — one finished book, badge-sized. */
export interface ShelfCoverage {
  bookId: string;
  totalTokens: number;
  masteredTokens: number;
  familiarTokens: number;
  nameTokens: number;
  baselineBooks: number;
}

/** Mirrors the backend's `VocabProfileClearPreview` — the dialog's two columns. */
export interface VocabProfileClearPreview {
  autoMasteryWords: number;
  exposureRecords: number;
  computedBooks: number;
  manualWords: number;
  vocabWords: number;
}

/** How far clearing the profile has got, in exposure rows (09b). */
export interface ClearProgress {
  cleared: number;
  total: number;
  done: boolean;
}

export function bookCoverageEvent(bookId: string): string {
  return `book-coverage-${bookId}`;
}

export function bookCoverageProgressEvent(bookId: string): string {
  return `book-coverage-progress-${bookId}`;
}

export const CLEAR_PROGRESS_EVENT = "vocab-profile-clear-progress";

export function getBookCoverage(bookId: string): Promise<BookReaderCoverage> {
  return invoke<BookReaderCoverage>("get_book_coverage", { bookId });
}

export function computeBookCoverage(bookId: string): Promise<void> {
  return invoke<void>("compute_book_coverage", { bookId });
}

export function getVocabProfile(): Promise<VocabProfileSummary> {
  return invoke<VocabProfileSummary>("get_vocab_profile");
}

export function getBookUnknownWords(
  bookId: string,
  countFamiliar: boolean,
): Promise<UnknownWord[]> {
  return invoke<UnknownWord[]>("get_book_unknown_words", { bookId, countFamiliar });
}

export function listShelfCoverage(): Promise<ShelfCoverage[]> {
  return invoke<ShelfCoverage[]>("list_shelf_coverage");
}

export function previewVocabProfileClear(): Promise<VocabProfileClearPreview> {
  return invoke<VocabProfileClearPreview>("preview_vocab_profile_clear");
}

export function clearVocabProfile(): Promise<void> {
  return invoke<void>("clear_vocab_profile");
}

export interface UseBookCoverage {
  coverage: BookReaderCoverage | null;
  profile: VocabProfileSummary | null;
  /** Live during a scan, `null` otherwise. */
  progress: CoverageProgress | null;
  loading: boolean;
  /** A command that failed to dispatch — distinct from `status: failed`,
   *  which is a computation that ran and did not finish. */
  callError: string | null;
  compute: () => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * One book's reader-relative coverage, plus the profile it is measured
 * against, kept current while a scan runs.
 *
 * Opening the page never starts a computation. The subscription is for the
 * case where one is already running, so "正在对一遍" can become a number
 * without a reload — and, per 05b, without the old number blinking out first.
 */
export function useBookCoverage(bookId: string | undefined): UseBookCoverage {
  const [coverage, setCoverage] = useState<BookReaderCoverage | null>(null);
  const [profile, setProfile] = useState<VocabProfileSummary | null>(null);
  const [progress, setProgress] = useState<CoverageProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [callError, setCallError] = useState<string | null>(null);

  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(async () => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!bookId) {
      setCoverage(null);
      setProfile(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setCallError(null);

    Promise.all([getBookCoverage(bookId), getVocabProfile()])
      .then(([row, summary]) => {
        if (!alive) return;
        setCoverage(row);
        setProfile(summary);
      })
      .catch((error) => {
        if (alive) setCallError(String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    const stops: UnlistenFn[] = [];
    const track = (unlisten: UnlistenFn) => {
      if (alive) stops.push(unlisten);
      else unlisten();
    };

    listen<BookReaderCoverage>(bookCoverageEvent(bookId), (event) => {
      // A late event for a book already navigated away from must not write
      // into state: `alive` covers teardown, the id check covers a payload
      // that simply is not about this book.
      if (!alive || event.payload.bookId !== bookId) return;
      setCoverage(event.payload);
      setProgress(null);
      // The scan just finished against whatever the profile is now; the
      // captions beside it quote profile counts, so refresh them together.
      getVocabProfile()
        .then((summary) => {
          if (alive) setProfile(summary);
        })
        .catch(() => {});
    })
      .then(track)
      .catch(() => {});

    listen<CoverageProgress>(bookCoverageProgressEvent(bookId), (event) => {
      if (!alive) return;
      setProgress(event.payload);
    })
      .then(track)
      .catch(() => {});

    return () => {
      alive = false;
      for (const stop of stops) stop();
    };
  }, [bookId, reloadToken]);

  const compute = useCallback(async () => {
    if (!bookId) return;
    setCallError(null);
    // Paint `running` at once. The old numbers stay put (05b) — they are true
    // of the profile they were computed from, and blanking them would be a
    // worse lie than showing them with their date on.
    setCoverage((prev) => (prev ? { ...prev, status: "running", error: null } : prev));
    try {
      await computeBookCoverage(bookId);
    } catch (error) {
      setCallError(String(error));
      try {
        const row = await getBookCoverage(bookId);
        setCoverage(row);
      } catch {
        /* The call error above is what there is to say. */
      }
    }
  }, [bookId]);

  return { coverage, profile, progress, loading, callError, compute, reload };
}
