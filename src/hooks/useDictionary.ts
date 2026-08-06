import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyReaders } from "../utils/notifyReaders";
import { saveVocabWord } from "../components/vocab/collect";

export interface DictionaryWord {
  id: string;
  book_id: string;
  word: string;
  definition: string;
  context_sentence: string | null;
  context_explanation: string | null;
  cfi: string | null;
  mastery: string;
  /** 'auto' when the reading-exposure engine decided the tier, 'manual' otherwise. */
  mastery_source: string;
  /** The facts the word-detail explanation sentence is rendered from, or null. */
  mastery_reason: string | null;
  /**
   * 'confirmed' once the reader saved the word (or looked it up a 3rd
   * cumulative time in the same book), 'watchlist' before that — a lookup's
   * first appearance, not yet something the reader chose to keep. Not a
   * concept shown to the reader: the vocab list hooks below filter it out by
   * default, it never gets its own row or badge.
   */
  list_status: "confirmed" | "watchlist";
  review_count: number;
  next_review_at: number | null;
  review_interval_days: number;
  last_reviewed_at: number | null;
  last_review_rating: "again" | "hard" | "good" | "easy" | null;
  created_at: number;
  updated_at: number;
  book_title: string | null;
  /**
   * Derived by the backend from lookup history, so it is only present on the
   * full vocabulary listing and absent (undefined) on partial updates such as
   * a recorded review.
   */
  chapter?: string | null;
}

export interface LookupRecord {
  id: string;
  book_id: string;
  lookup_text: string;
  normalized_text: string;
  context_sentence: string | null;
  chapter: string | null;
  cfi: string | null;
  definition: string;
  context_explanation: string | null;
  result_json?: string | null;
  provider_profile_id?: string | null;
  model?: string | null;
  updated_at: number;
  created_at: number;
  last_looked_up_at: number;
  lookup_count: number;
  book_title: string | null;
}

export interface LookupRecordPage {
  records: LookupRecord[];
  next_cursor: string | null;
  total: number;
  books: LookupBookFacet[];
}

export interface LookupBookFacet {
  book_id: string;
  book_title: string | null;
  count: number;
}

export function useDictionary(bookId: string) {
  const [words, setWords] = useState<DictionaryWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<DictionaryWord[]>("list_vocab_words", { bookId });
      // The backend command stays unfiltered — `useFoliateAnnotations` calls
      // it directly for in-text markers, which must still see watchlist
      // words. The vocab list itself is the one place that defaults to
      // hiding them; see the `list_status` doc comment above.
      setWords(result.filter((word) => word.list_status === "confirmed"));
    } catch (err) {
      console.error("Failed to load vocab words:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (
      word: string,
      definition: string,
      contextSentence?: string,
      cfi?: string,
      contextExplanation?: string
    ) => {
      const dictionaryWord = await saveVocabWord<DictionaryWord>({
        bookId,
        word,
        gloss: definition,
        contextSentence: contextSentence || null,
        contextExplanation: contextExplanation || null,
        cfi: cfi || null,
      });
      setWords((prev) => [dictionaryWord, ...prev]);
      notifyReaders("vocab-changed", { bookId, cfi });
      return dictionaryWord;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    const word = words.find((item) => item.id === id);
    await invoke("remove_vocab_word", { id });
    setWords((prev) => prev.filter((w) => w.id !== id));
    notifyReaders("vocab-changed", { bookId: word?.book_id, cfi: word?.cfi });
  }, [words]);

  const checkExists = useCallback(
    async (word: string): Promise<string | null> => {
      return invoke<string | null>("check_vocab_exists", { bookId, word });
    },
    [bookId]
  );

  return { words, refresh, add, remove, checkExists };
}

export function useAllDictionary() {
  const [words, setWords] = useState<DictionaryWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<DictionaryWord[]>("list_all_vocab_words");
      // See the matching comment in `useDictionary` above: watchlist words
      // are excluded from the vocab list by default, not deleted or hidden
      // behind a toggle — they simply aren't part of this hook's result.
      setWords(result.filter((word) => word.list_status === "confirmed"));
    } catch (err) {
      console.error("Failed to load all vocab words:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const word = words.find((item) => item.id === id);
    await invoke("remove_vocab_word", { id });
    setWords((prev) => prev.filter((w) => w.id !== id));
    notifyReaders("vocab-changed", { bookId: word?.book_id, cfi: word?.cfi });
  }, [words]);

  const updateMastery = useCallback(async (id: string, mastery: "new" | "learning" | "familiar" | "mastered", nextReviewAt: number | null) => {
    const changed = words.find((word) => word.id === id);
    await invoke("update_vocab_mastery", { id, mastery, nextReviewAt });
    setWords((prev) => prev.map((word) => word.id === id
      ? { ...word, mastery, next_review_at: nextReviewAt, updated_at: Date.now() }
      : word));
    notifyReaders("vocab-changed", { bookId: changed?.book_id, cfi: changed?.cfi });
  }, [words]);

  const recordReview = useCallback(async (id: string, rating: "again" | "hard" | "good" | "easy") => {
    const reviewed = await invoke<DictionaryWord>("record_vocab_review", { id, rating });
    setWords((prev) => prev.map((word) => word.id === id ? { ...word, ...reviewed } : word));
    notifyReaders("vocab-changed", { bookId: reviewed.book_id, cfi: reviewed.cfi });
    return reviewed;
  }, []);

  return { words, refresh, remove, updateMastery, recordReview };
}

export function useAllLookupHistory() {
  const [records, setRecords] = useState<LookupRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [books, setBooks] = useState<LookupBookFacet[]>([]);
  const requestGenerationRef = useRef(0);

  const refresh = useCallback(async (search?: string, bookId?: string) => {
    const generation = ++requestGenerationRef.current;
    try {
      const page = await invoke<LookupRecordPage>("list_all_lookup_records", {
        search: search || null,
        bookId: bookId || null,
        cursor: null,
        limit: 50,
      });
      if (generation !== requestGenerationRef.current) return;
      setRecords(page.records);
      setTotal(page.total);
      setCursor(page.next_cursor);
      setBooks(page.books);
    } catch (err) {
      console.error("Failed to load lookup history:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = useCallback(async (search?: string, bookId?: string) => {
    if (!cursor || loadingMore) return;
    const generation = requestGenerationRef.current;
    setLoadingMore(true);
    try {
      const page = await invoke<LookupRecordPage>("list_all_lookup_records", {
        search: search || null,
        bookId: bookId || null,
        cursor,
        limit: 50,
      });
      if (generation !== requestGenerationRef.current) return;
      setRecords((previous) => [...previous, ...page.records]);
      setCursor(page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const remove = useCallback(async (id: string) => {
    const record = records.find((item) => item.id === id);
    await invoke("delete_lookup_record", { id });
    setRecords((previous) => previous.filter((item) => item.id !== id));
    setTotal((previous) => Math.max(0, previous - 1));
    notifyReaders("lookup-record-changed", { bookId: record?.book_id, cfi: record?.cfi });
  }, [records]);

  const clear = useCallback(async (bookId?: string) => {
    await invoke("clear_lookup_records", { bookId: bookId || null });
    setRecords([]);
    setTotal(0);
    setCursor(null);
    notifyReaders("lookup-record-changed", { bookId });
  }, []);

  useEffect(() => {
    const refreshForChange = () => { refresh(); };
    window.addEventListener("lookup-record-changed", refreshForChange);
    return () => window.removeEventListener("lookup-record-changed", refreshForChange);
  }, [refresh]);

  return { records, total, books, hasMore: cursor !== null, loadingMore, refresh, loadMore, remove, clear };
}
