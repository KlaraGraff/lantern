import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnswerSheet, Quiz } from "../src/quiz/types.ts";
import type { GrammarVerdict } from "../src/quiz/judge.ts";
import { gradeQuiz } from "../src/quiz/grading.ts";

// 迁自 labs/cijuan/src/store/grading.test.ts（vitest → node:test）。
// 夹具相对原版的改动：ReadingQuestion/GrammarFillQuestion 不再有 `explanation`
// 字段（拍板 C，旧版一段式讲解不迁移）；GrammarFillQuestion 新增必填 passageId
// （两阶段生成分组用，见 src/quiz/types.ts 的说明）。

function makeQuiz(): Quiz {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    config: {
      difficulty: "cet6",
      types: ["reading", "grammarFill"],
      materialSource: "ai-original",
      model: "demo",
      maskedCheck: false,
    },
    words: [
      { word: "subsidy", origin: "today" },
      { word: "advocate", origin: "today" },
    ],
    passages: [],
    readingQuestions: [
      {
        id: "rq1",
        type: "reading",
        passageId: "p1",
        targetWord: "subsidy",
        stem: "stem",
        options: [],
        answer: "A",
        source: { passageId: "p1", paragraph: 1, quote: "" },
      },
    ],
    grammarQuestions: [
      {
        id: "gq1",
        type: "grammarFill",
        passageId: "p1",
        targetWord: "advocate",
        sentence: "sentence",
        hint: "advocate",
        answer: "have advocated",
      },
    ],
    status: "ready",
  };
}

describe("gradeQuiz", () => {
  it("全对", () => {
    const quiz = makeQuiz();
    const answers: AnswerSheet = { rq1: "A", gq1: "have advocated" };
    const grammarVerdicts: GrammarVerdict[] = [{ questionId: "gq1", correct: true }];
    const result = gradeQuiz(quiz, answers, grammarVerdicts);
    assert.equal(result.score, 2);
    assert.equal(result.total, 2);
    assert.deepEqual(result.wrongWords, []);
  });

  it("全错", () => {
    const quiz = makeQuiz();
    const answers: AnswerSheet = { rq1: "B", gq1: "advocate" };
    const grammarVerdicts: GrammarVerdict[] = [
      { questionId: "gq1", correct: false, note: "拼写不符标准答案" },
    ];
    const result = gradeQuiz(quiz, answers, grammarVerdicts);
    assert.equal(result.score, 0);
    assert.equal(result.total, 2);
    assert.deepEqual([...result.wrongWords].sort(), ["advocate", "subsidy"]);
    const gqVerdict = result.verdicts.find((v) => v.questionId === "gq1");
    assert.equal(gqVerdict?.judgeNote, "拼写不符标准答案");
  });

  it("未作答算错，userAnswer 记空串", () => {
    const quiz = makeQuiz();
    const result = gradeQuiz(quiz, {}, []);
    const rqVerdict = result.verdicts.find((v) => v.questionId === "rq1");
    const gqVerdict = result.verdicts.find((v) => v.questionId === "gq1");
    assert.equal(rqVerdict?.correct, false);
    assert.equal(rqVerdict?.userAnswer, "");
    assert.equal(gqVerdict?.correct, false);
    assert.equal(gqVerdict?.userAnswer, "");
  });

  it("语法题按传入的 LLM verdict 判定，并带上 judgeNote", () => {
    const quiz = makeQuiz();
    const answers: AnswerSheet = { gq1: "has advocated" };
    const grammarVerdicts: GrammarVerdict[] = [
      { questionId: "gq1", correct: true, note: "接受了变体时态" },
    ];
    const result = gradeQuiz(quiz, answers, grammarVerdicts);
    const gqVerdict = result.verdicts.find((v) => v.questionId === "gq1");
    assert.equal(gqVerdict?.correct, true);
    assert.equal(gqVerdict?.judgeNote, "接受了变体时态");
  });

  it("wrongWords 去重：同一考点词多道题都错只出现一次", () => {
    const quiz = makeQuiz();
    quiz.readingQuestions.push({
      id: "rq2",
      type: "reading",
      passageId: "p1",
      targetWord: "subsidy",
      stem: "stem2",
      options: [],
      answer: "A",
      source: { passageId: "p1", paragraph: 1, quote: "" },
    });
    const answers: AnswerSheet = { rq1: "B", rq2: "B", gq1: "have advocated" };
    const grammarVerdicts: GrammarVerdict[] = [{ questionId: "gq1", correct: true }];
    const result = gradeQuiz(quiz, answers, grammarVerdicts);
    assert.deepEqual(result.wrongWords, ["subsidy"]);
  });
});
