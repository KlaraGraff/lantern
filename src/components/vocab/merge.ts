import type { DictionaryWord } from "../../hooks/useDictionary";

/**
 * The same word saved from three books is three rows in `vocab_words` but one
 * thing to the reader. The merge key is deliberately dumb — exact spelling,
 * case-folded and trimmed — so "run" and "running" stay apart.
 */
export function vocabMergeKey(word: string): string {
  return word.trim().toLowerCase();
}

export interface MergedVocabBook {
  id: string;
  title: string | null;
}

export interface MergedVocabEntry {
  key: string;
  /** Spelling shown in the row: the primary row's. */
  word: string;
  /** Every saved row for this word, primary first. */
  rows: DictionaryWord[];
  primary: DictionaryWord;
  /** Distinct books this word was saved from, in row order. */
  books: MergedVocabBook[];
  /** Rows whose definition differs from the primary's, one per distinct text. */
  altRows: DictionaryWord[];
  /** Earliest scheduled review across the rows, or null when none is due. */
  nextReviewAt: number | null;
  /** The row carrying that earliest schedule — the one review rates. */
  representative: DictionaryWord;
}

/**
 * "Most recent" for a definition means the row that was touched last, falling
 * back to the newest one saved. Mastery write-through leaves siblings sharing
 * an `updated_at`, so the creation time is what actually breaks those ties.
 */
function morePrimaryThan(candidate: DictionaryWord, current: DictionaryWord): boolean {
  if (candidate.updated_at !== current.updated_at) return candidate.updated_at > current.updated_at;
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id < current.id;
}

function earlierSchedule(candidate: DictionaryWord, current: DictionaryWord): boolean {
  if (candidate.next_review_at === null) return false;
  if (current.next_review_at === null) return true;
  return candidate.next_review_at < current.next_review_at;
}

/**
 * Groups rows into one entry per word, preserving the order the caller sorted
 * them in: an entry takes the position of its first row, so "newest" and "A–Z"
 * keep meaning what they meant before the merge.
 *
 * `primaryOverrides` maps a merge key to the row id the reader promoted with
 * "use as main definition".
 */
export function mergeVocabWords(
  rows: DictionaryWord[],
  primaryOverrides: Record<string, string> = {},
): MergedVocabEntry[] {
  const order: string[] = [];
  const grouped = new Map<string, DictionaryWord[]>();
  for (const row of rows) {
    const key = vocabMergeKey(row.word);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else {
      grouped.set(key, [row]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const bucket = grouped.get(key)!;
    const overridden = primaryOverrides[key];
    let primary = bucket[0];
    for (const row of bucket) {
      if (row.id === overridden) {
        primary = row;
        break;
      }
      if (morePrimaryThan(row, primary)) primary = row;
    }

    const rest = bucket.filter((row) => row.id !== primary.id);
    const entryRows = [primary, ...rest];

    const books: MergedVocabBook[] = [];
    for (const row of entryRows) {
      if (!books.some((book) => book.id === row.book_id)) {
        books.push({ id: row.book_id, title: row.book_title });
      }
    }

    const primaryText = primary.definition.trim();
    const seen = new Set([primaryText]);
    const altRows: DictionaryWord[] = [];
    for (const row of rest) {
      const text = row.definition.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      altRows.push(row);
    }

    let representative = entryRows[0];
    for (const row of entryRows) {
      if (earlierSchedule(row, representative)) representative = row;
    }

    return {
      key,
      word: primary.word,
      rows: entryRows,
      primary,
      books,
      altRows,
      nextReviewAt: representative.next_review_at,
      representative,
    };
  });
}

/**
 * How many distinct books each word lives in, across the whole library. The
 * by-book view needs this to mark a row as "same word, another book" even
 * though its own group only shows one of them.
 */
export function bookCountsByWord(rows: DictionaryWord[]): Map<string, number> {
  const books = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = vocabMergeKey(row.word);
    const bucket = books.get(key);
    if (bucket) bucket.add(row.book_id);
    else books.set(key, new Set([row.book_id]));
  }
  return new Map([...books].map(([key, ids]) => [key, ids.size]));
}

/** The rows a review round would rate: one per word, never one per record. */
export function dueMergedEntries(entries: MergedVocabEntry[], now: number): MergedVocabEntry[] {
  return entries.filter((entry) => entry.nextReviewAt !== null && entry.nextReviewAt <= now);
}

/**
 * Whole days until a word comes up for review. `null` when it is not scheduled,
 * zero or negative once it is due. Rounded up, so anything still ahead of now
 * reads as at least one day away rather than collapsing into "today".
 */
export function daysUntilDue(nextReviewAt: number | null, now: number): number | null {
  if (nextReviewAt === null) return null;
  return Math.ceil((nextReviewAt - now) / (24 * 60 * 60 * 1000));
}
