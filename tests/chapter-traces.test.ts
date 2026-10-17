import { test } from "node:test";
import assert from "node:assert/strict";
import { cfiSectionIndex, chapterQuestions, inChapter } from "../src/pages/reader/chapter-traces.ts";

test("a CFI's first spine step names its section", () => {
  assert.equal(cfiSectionIndex("epubcfi(/6/2!/4/4/1:8)"), 0);
  assert.equal(cfiSectionIndex("epubcfi(/6/14!/4/2/40)"), 6);
  assert.equal(cfiSectionIndex("epubcfi(/6/4!/4/2/2,/1:0,/1:42)"), 1);
  assert.equal(cfiSectionIndex("textloc:v2:0:0"), null);
  assert.equal(cfiSectionIndex("epubcfi(/6/3!/4)"), null);
  assert.equal(cfiSectionIndex(null), null);
});

test("a chapter is an inclusive section range, open-ended at the last one", () => {
  assert.equal(inChapter(3, { start: 2, end: 4 }), true);
  assert.equal(inChapter(4, { start: 2, end: 4 }), true);
  assert.equal(inChapter(5, { start: 2, end: 4 }), false);
  assert.equal(inChapter(1, { start: 2, end: 4 }), false);
  assert.equal(inChapter(40, { start: 2 }), true);
  assert.equal(inChapter(3, {}), false);
  assert.equal(inChapter(null, { start: 0 }), false);
});

const message = (id: string, metadata: object | null, role = "user", created_at = 1) => ({
  id,
  chat_id: `chat-${id}`,
  role,
  content: `question ${id}`,
  metadata: metadata ? JSON.stringify(metadata) : null,
  created_at,
});

test("questions are the reader's own messages asked from this chapter, oldest first", () => {
  const questions = chapterQuestions([
    message("a", { sectionIndex: 3 }, "user", 20),
    message("b", { sectionIndex: 9 }),
    message("c", { sectionIndex: 3 }, "assistant"),
    message("d", { cfi: "epubcfi(/6/8!/4/2)" }, "user", 10),
    message("e", null),
    { ...message("f", "{" as unknown as object), metadata: "{" },
  ], { start: 2, end: 4 });
  assert.deepEqual(questions.map((question) => question.id), ["d", "a"]);
  assert.equal(questions[0].chatId, "chat-d");
});
