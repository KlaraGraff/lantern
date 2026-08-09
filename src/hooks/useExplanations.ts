import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A saved passage explanation. Mirrors `Explanation` in
 * `src-tauri/src/commands/explanations.rs` field-for-field — invoke
 * *parameters* are camelCase (Tauri's doing), but everything that comes back
 * out keeps the Rust struct's snake_case exactly as declared.
 *
 * Every AI explain result is cached the moment it's produced (`saved =
 * false`), so a re-selected passage replays for free. Saving flips this to
 * `true`; the list this hook feeds only ever shows `saved` rows, and "moving
 * one out" flips it back rather than deleting the cache underneath it.
 */
export interface Explanation {
  id: string;
  book_id: string;
  passage: string;
  normalized_passage: string;
  explanation: string;
  context_sentence: string | null;
  chapter: string | null;
  cfi: string;
  variant: string;
  provider_profile_id: string | null;
  model: string | null;
  saved: boolean;
  created_at: number;
  updated_at: number;
  book_title?: string | null;
}

export interface ExplanationBookFacet {
  book_id: string;
  book_title: string | null;
  count: number;
}

interface ExplanationPage {
  items: Explanation[];
  next_cursor: string | null;
  total: number;
  books: ExplanationBookFacet[];
}

const PAGE_SIZE = 100;

/**
 * The sidebar "解释" list — every saved explanation, across every book.
 * Shape mirrors `useAllLookupHistory` (`src/hooks/useDictionary.ts`): the
 * hook owns the fetched page, callers own the search/book filter state and
 * decide when to debounce a `refresh`.
 */
export function useExplanations() {
  const [items, setItems] = useState<Explanation[]>([]);
  const [total, setTotal] = useState(0);
  const [books, setBooks] = useState<ExplanationBookFacet[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Guards against an in-flight page landing after a newer one already did —
  // fires when the search/book filter changes fast enough to fire off two
  // requests before the first resolves.
  const requestGenerationRef = useRef(0);

  const refresh = useCallback(async (search?: string, bookId?: string) => {
    const generation = ++requestGenerationRef.current;
    try {
      const page = await invoke<ExplanationPage>("list_explanations", {
        search: search || null,
        bookId: bookId || null,
        cursor: null,
        limit: PAGE_SIZE,
      });
      if (generation !== requestGenerationRef.current) return;
      // Defensive: an unstubbed/mismatched backend can answer with a partial
      // object (the smoke harness's fallback for a command with no fixture
      // does exactly this) — fall back to an empty page rather than storing
      // `undefined` where callers expect arrays to iterate.
      setItems(page.items ?? []);
      setTotal(page.total ?? 0);
      setCursor(page.next_cursor ?? null);
      setBooks(page.books ?? []);
    } catch (err) {
      console.error("Failed to load explanations:", err);
    }
  }, []);

  const loadMore = useCallback(async (search?: string, bookId?: string) => {
    if (!cursor || loadingMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    try {
      const page = await invoke<ExplanationPage>("list_explanations", {
        search: search || null,
        bookId: bookId || null,
        cursor,
        limit: PAGE_SIZE,
      });
      if (generation !== requestGenerationRef.current) return;
      setItems((previous) => [...previous, ...(page.items ?? [])]);
      setCursor(page.next_cursor ?? null);
      setTotal(page.total ?? 0);
      setBooks(page.books ?? []);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  /**
   * "Move out of the list" — not a delete. The cache row survives with
   * `saved = false`, so the same passage still replays for free next time;
   * only its place in this list goes away.
   */
  const remove = useCallback(async (id: string) => {
    await invoke("set_explanation_saved", { id, saved: false });
    setItems((previous) => previous.filter((item) => item.id !== id));
    setTotal((previous) => Math.max(0, previous - 1));
  }, []);

  return { items, total, books, hasMore: cursor !== null, loadingMore, refresh, loadMore, remove };
}
