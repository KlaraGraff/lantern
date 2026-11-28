import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VOCAB_BACKUP_CSV_HEADERS, vocabBackupCsvRow, type VocabBackupCsvWord } from "../src/components/vocab/backup-csv.ts";

const quizWord: VocabBackupCsvWord = {
  id: "quiz-1", book_id: null, word: "ephemeral", definition: "Short-lived",
  context_sentence: null, context_explanation: null, cfi: null, mastery: "new",
  review_count: 0, next_review_at: null, review_interval_days: 0, last_reviewed_at: null,
  last_review_rating: null, fsrs_stability: null, fsrs_difficulty: null, fsrs_version: 1,
  created_at: 1, updated_at: 2, source: "quiz", source_label: "8/14 今日词卷",
};

describe("vocabulary backup CSV", () => {
  it("writes where a word was saved from, so a quiz word does not come back as a book word", () => {
    const row = vocabBackupCsvRow("lantern-vocabulary", 1, quizWord);
    assert.equal(row.length, VOCAB_BACKUP_CSV_HEADERS.length);
    const cell = (header: string) => row[VOCAB_BACKUP_CSV_HEADERS.indexOf(header)];
    assert.equal(cell("source"), "quiz");
    assert.equal(cell("source_label"), "8/14 今日词卷");
    assert.equal(cell("word"), "ephemeral");
  });
  it("adds the new columns at the end, so files from older versions still line up", () => {
    assert.deepEqual(VOCAB_BACKUP_CSV_HEADERS.slice(0, 20), [
      "backup_schema", "backup_version", "id", "book_id", "word", "definition",
      "context_sentence", "context_explanation", "cfi", "mastery", "review_count",
      "next_review_at", "review_interval_days", "last_reviewed_at", "last_review_rating",
      "fsrs_stability", "fsrs_difficulty", "fsrs_version", "created_at", "updated_at",
    ]);
    assert.deepEqual(VOCAB_BACKUP_CSV_HEADERS.slice(20), ["source", "source_label"]);
  });
});
