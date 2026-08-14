import assert from "node:assert/strict";
import test from "node:test";
import {
  QUIZ_VOCAB_GROUP_ID,
  isBooklessVocabRow,
  vocabGroupId,
  vocabGroupLabel,
  vocabSourceText,
  type VocabSourceRow,
} from "../src/components/vocab/source-label.ts";

/** 只回显 key 与插值，好断言到底取了哪条文案。 */
function t(key: string, values?: Record<string, string>): string {
  return values ? `${key}(${Object.values(values).join(",")})` : key;
}

const fromBook: VocabSourceRow = { book_id: "b1", book_title: "苔丝" };
const fromQuiz: VocabSourceRow = { book_id: null, book_title: null, source_label: "8/14 今日词卷" };

test("有书的行来源是书名", () => {
  assert.equal(isBooklessVocabRow(fromBook), false);
  assert.equal(vocabSourceText(fromBook, t), "苔丝");
});

test("书名缺失时才回退到未知书籍", () => {
  assert.equal(vocabSourceText({ book_id: "b1", book_title: "  " }, t), "common.unknownBook");
});

test("词卷收藏的行印「词卷 · 卷名」，不印未知书籍", () => {
  assert.equal(isBooklessVocabRow(fromQuiz), true);
  assert.equal(vocabSourceText(fromQuiz, t), "quizLookup.vocabSource(8/14 今日词卷)");
});

test("连卷名都没有的词卷行只印「词卷」", () => {
  assert.equal(vocabSourceText({ book_id: null }, t), "quizLookup.vocabGroup");
  assert.equal(vocabSourceText({ book_id: null, source_label: "   " }, t), "quizLookup.vocabGroup");
});

test("按书分组时无书行自成一组", () => {
  assert.equal(vocabGroupId(fromBook), "b1");
  assert.equal(vocabGroupId(fromQuiz), QUIZ_VOCAB_GROUP_ID);
  assert.equal(vocabGroupLabel(fromQuiz, t), "quizLookup.vocabGroup");
  assert.equal(vocabGroupLabel(fromBook, t), "苔丝");
});

test("空字符串的 book_id 当作没有书（后端历史行的保险）", () => {
  assert.equal(isBooklessVocabRow({ book_id: "" }), true);
  assert.equal(vocabGroupId({ book_id: "" }), QUIZ_VOCAB_GROUP_ID);
});
