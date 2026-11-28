/**
 * The vocabulary backup as CSV: its columns and how a word fills them.
 *
 * The backend reads these columns by name (`VocabCsvRow` in
 * `src-tauri/src/commands/vocab.rs`), and a missing column falls back to its
 * default. New columns therefore go at the end, so a file exported by an older
 * version still imports.
 */

export const VOCAB_BACKUP_CSV_HEADERS = [
  "backup_schema",
  "backup_version",
  "id",
  "book_id",
  "word",
  "definition",
  "context_sentence",
  "context_explanation",
  "cfi",
  "mastery",
  "review_count",
  "next_review_at",
  "review_interval_days",
  "last_reviewed_at",
  "last_review_rating",
  "fsrs_stability",
  "fsrs_difficulty",
  "fsrs_version",
  "created_at",
  "updated_at",
  // Where the word was saved from: "book", or "quiz" for a quiz paper, whose
  // words have no book. Without these, a re-imported quiz word was filed as
  // one saved from a book.
  "source",
  "source_label",
];

export interface VocabBackupCsvWord {
  id: string;
  book_id: string | null;
  word: string;
  definition: string;
  context_sentence: string | null;
  context_explanation: string | null;
  cfi: string | null;
  mastery: string;
  review_count: number;
  next_review_at: number | null;
  review_interval_days: number;
  last_reviewed_at: number | null;
  last_review_rating: string | null;
  fsrs_stability: number | null;
  fsrs_difficulty: number | null;
  fsrs_version: number;
  created_at: number;
  updated_at: number;
  source?: string;
  source_label?: string | null;
}

export type VocabBackupCsvCell = string | number | null | undefined;

/** One CSV row for `word`, in the order of `VOCAB_BACKUP_CSV_HEADERS`. */
export function vocabBackupCsvRow(schema: string, version: number, word: VocabBackupCsvWord): VocabBackupCsvCell[] {
  return [
    schema, version, word.id, word.book_id, word.word, word.definition,
    word.context_sentence, word.context_explanation, word.cfi, word.mastery,
    word.review_count, word.next_review_at, word.review_interval_days,
    word.last_reviewed_at, word.last_review_rating, word.fsrs_stability,
    word.fsrs_difficulty, word.fsrs_version, word.created_at, word.updated_at,
    word.source, word.source_label,
  ];
}
