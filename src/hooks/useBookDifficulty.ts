import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * `pending` is also what a book with no row at all reports — there is no
 * separate "never analyzed" value, because from the page's point of view the
 * two are the same thing: no numbers yet, and a button that starts them.
 *
 * `too_short` and `unsupported` are both permanent "no conclusion" answers,
 * and neither is a failure. `too_short` still carries a real distribution
 * (it just refuses to draw a verdict from it); `unsupported` carries nothing,
 * because the format was never opened.
 */
export type BookDifficultyStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "too_short"
  | "unsupported";

export type BookDifficultyOverride = "easier" | "matched" | "harder" | "hidden";

/** Mirrors the backend's `BookDifficulty` (serde `rename_all = "camelCase"`). */
export interface BookDifficulty {
  bookId: string;
  status: BookDifficultyStatus;
  totalTokens: number;
  distinctWords: number;
  band1: number;
  band2: number;
  band3: number;
  band4: number;
  band5: number;
  bandUnlisted: number;
  sourceSha256: string | null;
  /** RFC-3339 UTC. */
  computedAt: string | null;
  error: string | null;
  override: BookDifficultyOverride | null;
  /** The file changed after these numbers were computed. Nothing recomputes
   *  on its own — this only decides how loudly the page offers to. */
  stale: boolean;
}

/** The backend emits the finished row on this channel, one channel per book. */
export function bookDifficultyEvent(bookId: string): string {
  return `book-difficulty-${bookId}`;
}

export function getBookDifficulty(bookId: string): Promise<BookDifficulty> {
  return invoke<BookDifficulty>("get_book_difficulty", { bookId });
}

export function computeBookDifficulty(bookId: string): Promise<void> {
  return invoke<void>("compute_book_difficulty", { bookId });
}

export function setBookDifficultyOverride(
  bookId: string,
  value: BookDifficultyOverride | null,
): Promise<void> {
  return invoke<void>("set_book_difficulty_override", { bookId, value });
}

export interface UseBookDifficulty {
  difficulty: BookDifficulty | null;
  loading: boolean;
  /** A command that failed to even dispatch — distinct from `status: failed`,
   *  which is a completed analysis that did not finish. */
  callError: string | null;
  compute: () => Promise<void>;
  setOverride: (value: BookDifficultyOverride | null) => Promise<void>;
}

/**
 * Reads one book's word-frequency distribution and keeps it current.
 *
 * Opening this page never triggers a computation. The subscription exists for
 * the case where a computation is already running — started by the import
 * pipeline, or by the reader pressing the button here — so the "analyzing"
 * state can turn into a result without a reload.
 */
export function useBookDifficulty(bookId: string | undefined): UseBookDifficulty {
  const [difficulty, setDifficulty] = useState<BookDifficulty | null>(null);
  const [loading, setLoading] = useState(true);
  const [callError, setCallError] = useState<string | null>(null);
  useEffect(() => {
    if (!bookId) {
      setDifficulty(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setCallError(null);

    getBookDifficulty(bookId)
      .then((row) => {
        if (alive) setDifficulty(row);
      })
      .catch((error) => {
        if (alive) setCallError(String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    let stop: UnlistenFn | undefined;
    listen<BookDifficulty>(bookDifficultyEvent(bookId), (event) => {
      // A late event for a book the reader has already navigated away from
      // must not write into state: `alive` covers the teardown, and the id
      // check covers a payload that simply is not about this book.
      if (!alive || event.payload.bookId !== bookId) return;
      setDifficulty(event.payload);
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});

    return () => {
      alive = false;
      stop?.();
    };
  }, [bookId]);

  const compute = useCallback(async () => {
    if (!bookId) return;
    setCallError(null);
    // Paint `running` immediately rather than waiting for the backend's first
    // write to come back — the command returns before the work starts, so
    // without this the button appears to do nothing for a beat.
    setDifficulty((prev) => (prev ? { ...prev, status: "running", error: null } : prev));
    try {
      await computeBookDifficulty(bookId);
    } catch (error) {
      setCallError(String(error));
      try {
        const row = await getBookDifficulty(bookId);
        setDifficulty(row);
      } catch {
        /* The call error above is what there is to say. */
      }
    }
  }, [bookId]);

  const setOverride = useCallback(
    async (value: BookDifficultyOverride | null) => {
      if (!bookId) return;
      setCallError(null);
      const previous = difficulty;
      setDifficulty((prev) => (prev ? { ...prev, override: value } : prev));
      try {
        await setBookDifficultyOverride(bookId, value);
      } catch (error) {
        setCallError(String(error));
        setDifficulty(previous);
      }
    },
    [bookId, difficulty],
  );

  return { difficulty, loading, callError, compute, setOverride };
}
