import assert from "node:assert/strict";
import test from "node:test";
import {
  bookCountsByWord,
  dueMergedEntries,
  hasQuizSource,
  mergeVocabWords,
  vocabMergeKey,
} from "../src/components/vocab/merge.ts";
import { QUIZ_VOCAB_GROUP_ID, mergedVocabBookLabel } from "../src/components/vocab/source-label.ts";
import type { DictionaryWord } from "../src/hooks/useDictionary.ts";

function row(overrides: Partial<DictionaryWord> & { id: string; word: string }): DictionaryWord {
  return {
    book_id: "book-a",
    definition: "",
    context_sentence: null,
    context_explanation: null,
    cfi: null,
    mastery: "new",
    review_count: 0,
    next_review_at: null,
    review_interval_days: 0,
    last_reviewed_at: null,
    last_review_rating: null,
    created_at: 1_000,
    updated_at: 1_000,
    book_title: "Book A",
    ...overrides,
  };
}

test("the merge key folds case and surrounding space but nothing else", () => {
  assert.equal(vocabMergeKey("  Courage "), "courage");
  assert.notEqual(vocabMergeKey("running"), vocabMergeKey("run"));
});

test("the same word in three books becomes one entry", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "Courage", book_id: "a", book_title: "A" }),
    row({ id: "2", word: "courage", book_id: "b", book_title: "B" }),
    row({ id: "3", word: "solitude", book_id: "b", book_title: "B" }),
    row({ id: "4", word: "COURAGE", book_id: "c", book_title: "C" }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.key), ["courage", "solitude"]);
  assert.equal(entries[0].rows.length, 3);
  assert.deepEqual(entries[0].books.map((book) => book.id), ["a", "b", "c"]);
  assert.equal(entries[1].rows.length, 1);
});

test("an entry keeps the position of its first row, so sort order survives", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "zeal" }),
    row({ id: "2", word: "ache" }),
    row({ id: "3", word: "zeal", book_id: "b" }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.word), ["zeal", "ache"]);
});

test("the newest row supplies the primary definition, and older ones fold under it", () => {
  const entries = mergeVocabWords([
    row({ id: "old", word: "courage", definition: "older", created_at: 1, updated_at: 5 }),
    row({ id: "new", word: "courage", definition: "newer", created_at: 2, updated_at: 9, book_id: "b" }),
  ]);
  assert.equal(entries[0].primary.id, "new");
  assert.deepEqual(entries[0].altRows.map((alt) => alt.id), ["old"]);
});

test("mastery write-through flattens updated_at, so creation time breaks the tie", () => {
  const entries = mergeVocabWords([
    row({ id: "old", word: "courage", definition: "older", created_at: 1, updated_at: 100 }),
    row({ id: "new", word: "courage", definition: "newer", created_at: 2, updated_at: 100, book_id: "b" }),
  ]);
  assert.equal(entries[0].primary.id, "new");
});

test("a promoted row wins over the newest one", () => {
  const entries = mergeVocabWords(
    [
      row({ id: "old", word: "courage", definition: "older", created_at: 1, updated_at: 5 }),
      row({ id: "new", word: "courage", definition: "newer", created_at: 2, updated_at: 9, book_id: "b" }),
    ],
    { courage: "old" },
  );
  assert.equal(entries[0].primary.id, "old");
  assert.deepEqual(entries[0].altRows.map((alt) => alt.id), ["new"]);
});

test("rows repeating the primary definition are not offered as alternatives", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "courage", definition: "same", updated_at: 9 }),
    row({ id: "2", word: "courage", definition: " same ", book_id: "b" }),
    row({ id: "3", word: "courage", definition: "", book_id: "c" }),
  ]);
  assert.deepEqual(entries[0].altRows, []);
});

test("the earliest schedule decides what a review rates", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "courage", next_review_at: 900 }),
    row({ id: "2", word: "courage", next_review_at: 100, book_id: "b" }),
    row({ id: "3", word: "courage", next_review_at: null, book_id: "c" }),
  ]);
  assert.equal(entries[0].representative.id, "2");
  assert.equal(entries[0].nextReviewAt, 100);
});

test("a due count counts words, not records", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "courage", next_review_at: 100 }),
    row({ id: "2", word: "courage", next_review_at: 120, book_id: "b" }),
    row({ id: "3", word: "solitude", next_review_at: 5_000, book_id: "b" }),
  ]);
  assert.deepEqual(dueMergedEntries(entries, 200).map((entry) => entry.key), ["courage"]);
});

test("a quiz row merges as a pseudo-book that never reads 「未知书籍」", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "courage", book_id: "a", book_title: "A" }),
    row({ id: "2", word: "courage", book_id: null, book_title: null, source_label: "8/14 今日词卷" }),
    row({ id: "3", word: "courage", book_id: null, book_title: null, source_label: "8/15 今日词卷" }),
  ]);

  // 两条词卷行归并成同一个伪书组——它们都属于「词卷」这一处来源
  assert.deepEqual(
    entries[0].books.map((book) => book.id),
    ["a", QUIZ_VOCAB_GROUP_ID],
  );
  assert.equal(hasQuizSource(entries[0].books), true);

  // 删除弹窗等处印的名字：真书印书名，词卷印「词卷 · 卷名」，不落回未知书籍
  const t = (key: string, values?: Record<string, string>) =>
    key === "quizLookup.vocabSource" ? `词卷 · ${values?.label}` : key;
  assert.deepEqual(
    entries[0].books.map((book) => mergedVocabBookLabel(book, t)),
    ["A", "词卷 · 8/14 今日词卷"],
  );
});

test("an all-book entry has no quiz source and labels fall back to 未知书籍", () => {
  const entries = mergeVocabWords([
    row({ id: "1", word: "courage", book_id: "a", book_title: "A" }),
    row({ id: "2", word: "courage", book_id: "b", book_title: null }),
  ]);
  assert.equal(hasQuizSource(entries[0].books), false);
  const t = (key: string) => key;
  assert.deepEqual(
    entries[0].books.map((book) => mergedVocabBookLabel(book, t)),
    ["A", "common.unknownBook"],
  );
});

test("book counts see the whole library, not one group of it", () => {
  const counts = bookCountsByWord([
    row({ id: "1", word: "Courage", book_id: "a" }),
    row({ id: "2", word: "courage", book_id: "b" }),
    row({ id: "3", word: "courage", book_id: "b" }),
    row({ id: "4", word: "solitude", book_id: "b" }),
  ]);
  assert.equal(counts.get("courage"), 2);
  assert.equal(counts.get("solitude"), 1);
});
