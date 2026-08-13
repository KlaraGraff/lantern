import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countAnswered,
  explanationTriState,
  formatElapsed,
  grammarHasExplanation,
  groupExplanationMissing,
  readingHasExplanation,
} from "../src/pages/quiz/useQuizPaper.ts";
import { buildAskSystemPrompt } from "../src/pages/quiz/useAskThread.ts";
import type { GrammarFillQuestion, Quiz, QuizConfig, ReadingQuestion } from "../src/quiz/types.ts";

// 词卷试卷页的纯逻辑测试：解析三态判定（explanationTriState 及其两个组成判据）、
// 已作答计数、用时格式化、追问系统提示词拼装。UI 渲染本身（TakeView/GradeView/
// AskDrawer/QuizPaper）依赖 DOM，不在 node:test 覆盖范围内。

const config: QuizConfig = {
  difficulty: "cet6",
  types: ["reading", "grammarFill"],
  materialSource: "ai-original",
  model: "test-model",
  maskedCheck: true,
};

function readingQ(overrides: Partial<ReadingQuestion> = {}): ReadingQuestion {
  return {
    id: "r1",
    type: "reading",
    passageId: "p1",
    targetWord: "curb",
    stem: "stem",
    options: [
      { label: "A", text: "a" },
      { label: "B", text: "b" },
    ],
    answer: "A",
    source: { passageId: "p1", paragraph: 1, quote: "quote" },
    ...overrides,
  };
}

function grammarQ(overrides: Partial<GrammarFillQuestion> = {}): GrammarFillQuestion {
  return {
    id: "g1",
    type: "grammarFill",
    passageId: "p1",
    targetWord: "advocate",
    sentence: "They ____ reform.",
    hint: "advocate",
    answer: "advocated",
    ...overrides,
  };
}

function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "submitted",
    config,
    words: [{ word: "curb", origin: "today" }],
    passages: [{ id: "p1", title: "T", paragraphs: ["Paragraph."], targetWords: ["curb"] }],
    readingQuestions: [readingQ()],
    grammarQuestions: [grammarQ()],
    ...overrides,
  };
}

describe("readingHasExplanation / grammarHasExplanation", () => {
  it("阶段一刚交卷、阶段二字段全空时算没有解析", () => {
    assert.equal(readingHasExplanation(readingQ()), false);
    assert.equal(grammarHasExplanation(grammarQ()), false);
  });

  it("任一阶段二字段在即算有解析", () => {
    assert.equal(readingHasExplanation(readingQ({ wordNote: "curb: 抑制" })), true);
    assert.equal(
      readingHasExplanation(readingQ({ options: [{ label: "A", text: "a", meaning: "m" }] })),
      true,
    );
    assert.equal(grammarHasExplanation(grammarQ({ wordMeaning: "抑制" })), true);
    assert.equal(grammarHasExplanation(grammarQ({ wrongForms: [{ form: "x", note: "n" }] })), true);
  });
});

describe("groupExplanationMissing", () => {
  it("组内任一题缺字段，整组判缺", () => {
    const quiz = makeQuiz({
      readingQuestions: [readingQ({ id: "r1", wordNote: "done" })],
      grammarQuestions: [grammarQ({ id: "g1" })], // 语法题仍缺
    });
    assert.equal(groupExplanationMissing(quiz, "p1"), true);
  });

  it("组内所有题都有字段，判不缺", () => {
    const quiz = makeQuiz({
      readingQuestions: [readingQ({ id: "r1", wordNote: "done" })],
      grammarQuestions: [grammarQ({ id: "g1", wordMeaning: "done" })],
    });
    assert.equal(groupExplanationMissing(quiz, "p1"), false);
  });

  it("组内没有任何题时不算缺（防止误判不存在的组）", () => {
    const quiz = makeQuiz();
    assert.equal(groupExplanationMissing(quiz, "no-such-passage"), false);
  });
});

describe("explanationTriState", () => {
  it("running 且该组在本轮 scope 里 → 优先于缺失判定", () => {
    const quiz = makeQuiz(); // 阶段二字段全空，本该判 missing
    const state = explanationTriState(
      { running: true, runningPassageIds: ["p1"], missingPassageIds: [] },
      quiz,
      "p1",
    );
    assert.equal(state, "running");
  });

  it("running 但该组不在本轮 scope 里 → 按实际字段判定，不画骨架屏", () => {
    // 补生成只点名 p2 时，p1 不该跟着变骨架：缺字段照样显示 missing，
    // 有字段照常展开 ready。
    const session = { running: true, runningPassageIds: ["p2"], missingPassageIds: ["p1"] };
    assert.equal(explanationTriState(session, makeQuiz(), "p1"), "missing");

    const readyQuiz = makeQuiz({
      readingQuestions: [readingQ({ id: "r1", wordNote: "done" })],
      grammarQuestions: [grammarQ({ id: "g1", wordMeaning: "done" })],
    });
    assert.equal(explanationTriState(session, readyQuiz, "p1"), "ready");
  });

  it("!running 且缺字段 → missing", () => {
    const quiz = makeQuiz();
    const state = explanationTriState(
      { running: false, runningPassageIds: [], missingPassageIds: ["p1"] },
      quiz,
      "p1",
    );
    assert.equal(state, "missing");
  });

  it("session 为 undefined（冷启动）时仍按实际字段判定，不当成 running", () => {
    const missingQuiz = makeQuiz();
    assert.equal(explanationTriState(undefined, missingQuiz, "p1"), "missing");

    const readyQuiz = makeQuiz({
      readingQuestions: [readingQ({ id: "r1", wordNote: "done" })],
      grammarQuestions: [grammarQ({ id: "g1", wordMeaning: "done" })],
    });
    assert.equal(explanationTriState(undefined, readyQuiz, "p1"), "ready");
  });
});

describe("formatElapsed", () => {
  it("格式化为 mm:ss，四舍五入到秒", () => {
    assert.equal(formatElapsed(0), "00:00");
    assert.equal(formatElapsed(9_400), "00:09");
    assert.equal(formatElapsed(872_000), "14:32");
  });

  it("负数或异常输入夹到 0，不产出负号", () => {
    assert.equal(formatElapsed(-500), "00:00");
  });
});

describe("countAnswered", () => {
  it("只数非空白 trim 后的作答", () => {
    const ids = ["a", "b", "c"];
    assert.equal(countAnswered(ids, { a: "x", b: "   ", c: "" }), 1);
    assert.equal(countAnswered(ids, { a: "x", b: "y", c: "z" }), 3);
    assert.equal(countAnswered(ids, {}), 0);
  });
});

describe("buildAskSystemPrompt", () => {
  it("把引用片段、出处与上下文都编进提示词", () => {
    const prompt = buildAskSystemPrompt({
      quote: "curb industrial emissions",
      quoteFrom: "Passage 1 · ¶2",
      context: "Several governments have pledged to curb industrial emissions...",
    });
    assert.match(prompt, /curb industrial emissions/);
    assert.match(prompt, /Passage 1 · ¶2/);
    assert.match(prompt, /用中文回答/);
  });
});
