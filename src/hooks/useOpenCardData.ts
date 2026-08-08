import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Backend mirrors for the four read-only queries the Book Open Card is built
 * from (`src-tauri/src/commands/book_difficulty.rs`). Each type mirrors its
 * Rust struct's `serde(rename_all = "camelCase")` output field for field.
 */

/** The reader's own empirical pass rate by frequency band, over their whole
 *  lookup record — not scoped to one book. Index 0 is band 1; `null` means no
 *  evidence for that band at all. */
export interface VocabPassRates {
  bandPassRates: [number | null, number | null, number | null, number | null, number | null];
  scorableLookups: number;
  spanDays: number;
  sufficient: boolean;
}

export interface BookDifficultySection {
  sectionOrder: number;
  chapterTitle: string | null;
  totalTokens: number;
  band4: number;
  band5: number;
}

export interface BookLookupStats {
  lookedUpWords: number;
  masteredWords: number;
}

export interface ReadingPace {
  bookWordsPerMinute: number | null;
  overallWordsPerMinute: number | null;
}

export function getVocabPassRates(): Promise<VocabPassRates> {
  return invoke<VocabPassRates>("get_vocab_pass_rates");
}

export function getBookDifficultySections(bookId: string): Promise<BookDifficultySection[]> {
  return invoke<BookDifficultySection[]>("get_book_difficulty_sections", { bookId });
}

export function getBookLookupStats(bookId: string): Promise<BookLookupStats> {
  return invoke<BookLookupStats>("get_book_lookup_stats", { bookId });
}

export function getReadingPace(bookId: string): Promise<ReadingPace> {
  return invoke<ReadingPace>("get_reading_pace", { bookId });
}

interface AsyncSlice<T> {
  value: T | null;
  loading: boolean;
}

/**
 * `key` drives the effect, not the loader's identity — a loader recreated
 * every render (as every call site below does) would otherwise refetch on
 * every render rather than only when the thing being asked about changes.
 */
function useAsync<T>(key: string | null, load: () => Promise<T>): AsyncSlice<T> {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(key !== null);
  useEffect(() => {
    if (!key) {
      setValue(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    load()
      .then((result) => { if (alive) setValue(result); })
      .catch(() => { if (alive) setValue(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { value, loading };
}

/** The reader's pass rates, independent of which book is open. */
export function useVocabPassRates(enabled: boolean): AsyncSlice<VocabPassRates> {
  return useAsync(enabled ? "vocab-pass-rates" : null, getVocabPassRates);
}

export function useBookDifficultySections(bookId: string | null): AsyncSlice<BookDifficultySection[]> {
  return useAsync(bookId, () => getBookDifficultySections(bookId as string));
}

export function useBookLookupStats(bookId: string | null): AsyncSlice<BookLookupStats> {
  return useAsync(bookId, () => getBookLookupStats(bookId as string));
}

export function useReadingPace(bookId: string | null): AsyncSlice<ReadingPace> {
  return useAsync(bookId, () => getReadingPace(bookId as string));
}
