import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { quizContentJson, rowToQuiz, type QuizPaperRow } from "../src/pages/quiz/paper-io.ts";
import {
  getExplanationSession,
  mergeQuizQuestions,
  resetExplanationSessions,
  runExplanationSession,
  scopeQuiz,
} from "../src/pages/quiz/explanation-session.ts";
import type { CompleteStructured } from "../src/quiz/generate.ts";
import type { Quiz, QuizConfig } from "../src/quiz/types.ts";

// 词卷页 ↔ 做题/评卷页之间的两个契约模块的测试：试卷行解析（paper-io）与
// 阶段二后台解析会话（explanation-session）。generateExplanations 本身的编排
// 行为在 quiz-generate.test.ts 里已覆盖，这里只测会话层新增的语义：裁卷/合并、
// 失败组记账（含跨轮保留）、写库失败兜底、并发防重入。

const config: QuizConfig = {
  difficulty: "cet6",
  types: ["reading", "grammarFill"],
  materialSource: "ai-original",
  model: "test-model",
  maskedCheck: true,
};

/** 两篇文章各一道阅读题；p1 组另带一道语法题。 */
function makeQuiz(): Quiz {
  return {
    id: 7,
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "ready",
    config,
    words: [
      { word: "apple", origin: "today" },
      { word: "banana", origin: "vocab" },
    ],
    passages: [
      { id: "p1", title: "One", paragraphs: ["Apple paragraph."], targetWords: ["apple"] },
      { id: "p2", title: "Two", paragraphs: ["Banana paragraph."], targetWords: ["banana"] },
    ],
    readingQuestions: [
      {
        id: "r1",
        type: "reading",
        passageId: "p1",
        targetWord: "apple",
        stem: "About apple?",
        options: [
          { label: "A", text: "a" },
          { label: "B", text: "b" },
        ],
        answer: "A",
        source: { passageId: "p1", paragraph: 1, quote: "Apple paragraph." },
      },
      {
        id: "r2",
        type: "reading",
        passageId: "p2",
        targetWord: "banana",
        stem: "About banana?",
        options: [
          { label: "A", text: "a" },
          { label: "B", text: "b" },
        ],
        answer: "B",
        source: { passageId: "p2", paragraph: 1, quote: "Banana paragraph." },
      },
    ],
    grammarQuestions: [
      {
        id: "g1",
        type: "grammarFill",
        passageId: "p1",
        targetWord: "apple",
        sentence: "The funds ____ (apple).",
        hint: "apple",
        answer: "are appled",
      },
    ],
  };
}

/** 每组都成功、给第 0 题写入解析的测试替身。 */
const completeOk: CompleteStructured = (opts) =>
  Promise.resolve({
    data: {
      readingExplanations: [
        {
          questionIndex: 0,
          stemTranslation: "题干翻译",
          howToSolve: "解法",
          wordNote: "词卡",
          options: [
            { label: "A", meaning: "含义A", note: "为何对" },
            { label: "B", meaning: "含义B", note: "为何错" },
          ],
          answerDispute: null,
        },
      ],
      grammarExplanations: [],
    },
    requestMessage: JSON.stringify(opts.messages),
    rawResponse: "{}",
  }) as ReturnType<CompleteStructured>;

describe("paper-io", () => {
  it("rowToQuiz 解析三个 JSON 列并还原领域模型；quizContentJson 与 content 列互逆", () => {
    const quiz = makeQuiz();
    const row: QuizPaperRow = {
      id: 7,
      createdAt: quiz.createdAt,
      status: "ready",
      configJson: JSON.stringify(quiz.config),
      wordsJson: JSON.stringify(quiz.words),
      contentJson: quizContentJson(quiz),
      resultJson: null,
      askThreadsJson: null,
    };
    const parsed = rowToQuiz(row);
    assert.deepEqual(parsed, { ...quiz, result: undefined, askThreads: undefined });
  });

  it("result / askThreads 列存在时一并解析", () => {
    const quiz = makeQuiz();
    const result = {
      submittedAt: "2026-08-13T01:00:00.000Z",
      verdicts: [],
      score: 1,
      total: 3,
      wrongWords: ["banana"],
    };
    const threads = [
      {
        id: "t1",
        quote: "Apple paragraph.",
        quoteFrom: "文章 ¶1",
        context: "Apple paragraph.",
        messages: [],
        createdAt: "2026-08-13T01:01:00.000Z",
      },
    ];
    const row: QuizPaperRow = {
      id: 7,
      createdAt: quiz.createdAt,
      status: "submitted",
      configJson: JSON.stringify(quiz.config),
      wordsJson: JSON.stringify(quiz.words),
      contentJson: quizContentJson(quiz),
      resultJson: JSON.stringify(result),
      askThreadsJson: JSON.stringify(threads),
    };
    const parsed = rowToQuiz(row);
    assert.equal(parsed.status, "submitted");
    assert.deepEqual(parsed.result, result);
    assert.deepEqual(parsed.askThreads, threads);
  });
});

describe("explanation-session 纯函数", () => {
  it("scopeQuiz 只留指定组的文章与两类题", () => {
    const scoped = scopeQuiz(makeQuiz(), new Set(["p2"]));
    assert.deepEqual(scoped.passages.map((p) => p.id), ["p2"]);
    assert.deepEqual(scoped.readingQuestions.map((q) => q.id), ["r2"]);
    assert.deepEqual(scoped.grammarQuestions, []);
  });

  it("mergeQuizQuestions 按题 id 合并子卷更新、保持整卷题序", () => {
    const full = makeQuiz();
    const scoped = scopeQuiz(full, new Set(["p2"]));
    const updated: Quiz = {
      ...scoped,
      readingQuestions: [{ ...scoped.readingQuestions[0], stemTranslation: "香蕉题" }],
    };
    const merged = mergeQuizQuestions(full, updated);
    assert.deepEqual(merged.readingQuestions.map((q) => q.id), ["r1", "r2"]);
    assert.equal(merged.readingQuestions[0].stemTranslation, undefined);
    assert.equal(merged.readingQuestions[1].stemTranslation, "香蕉题");
    assert.equal(merged.passages.length, 2);
  });
});

describe("runExplanationSession", () => {
  beforeEach(() => resetExplanationSessions());

  it("全组成功：写回合并后的整卷，session 归零", async () => {
    const persisted: Quiz[] = [];
    const merged = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: completeOk,
      persist: (_id, q) => {
        persisted.push(q);
        return Promise.resolve();
      },
    });
    assert.ok(merged);
    assert.equal(merged.readingQuestions[0].stemTranslation, "题干翻译");
    assert.equal(merged.readingQuestions[1].stemTranslation, "题干翻译");
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], merged);
    assert.deepEqual(getExplanationSession(7), {
      running: false,
      runningPassageIds: [],
      missingPassageIds: [],
      missingErrorCodes: {},
    });
  });

  it("单组失败进 missingPassageIds；成功组照常写回", async () => {
    const completeP2Fails: CompleteStructured = (opts) => {
      if (JSON.stringify(opts.messages).includes("banana")) {
        return Promise.reject(new Error("boom"));
      }
      return completeOk(opts);
    };
    const merged = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: completeP2Fails,
      persist: () => Promise.resolve(),
    });
    assert.ok(merged);
    assert.equal(merged.readingQuestions[0].stemTranslation, "题干翻译");
    assert.equal(merged.readingQuestions[1].stemTranslation, undefined);
    assert.deepEqual(getExplanationSession(7), {
      running: false,
      runningPassageIds: [],
      missingPassageIds: ["p2"],
      // "boom" 不是注册表里的 AI 错误码，识别不出就不记原因
      missingErrorCodes: {},
    });
  });

  it("onlyPassageIds 补生成：只跑点名的组，其它组上一轮的失败记录保留", async () => {
    const calls: string[] = [];
    const complete: CompleteStructured = (opts) => {
      calls.push(JSON.stringify(opts.messages));
      return completeOk(opts);
    };
    // 先造出「p1、p2 都失败」的上一轮
    await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: () => Promise.reject(new Error("boom")),
      persist: () => Promise.resolve(),
    });
    assert.deepEqual(getExplanationSession(7)?.missingPassageIds.sort(), ["p1", "p2"]);

    const merged = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      onlyPassageIds: ["p1"],
      complete,
      persist: () => Promise.resolve(),
    });
    assert.ok(merged);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("apple") && !calls[0].includes("banana"));
    assert.equal(merged.readingQuestions[0].stemTranslation, "题干翻译");
    assert.deepEqual(getExplanationSession(7), {
      running: false,
      runningPassageIds: [],
      missingPassageIds: ["p2"],
      missingErrorCodes: {},
    });
  });

  it("失败原因码随组走：认得的错误码记进 missingErrorCodes，补生成成功后一起清掉", async () => {
    // 第一轮：p1 因钉住的出题模型不可用失败（后端 AppError 序列化成裸 token），p2 成功
    const completeP1ProfileGone: CompleteStructured = (opts) => {
      if (JSON.stringify(opts.messages).includes("apple")) {
        return Promise.reject(new Error("AI_PROFILE_NOT_AVAILABLE"));
      }
      return completeOk(opts);
    };
    await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: completeP1ProfileGone,
      persist: () => Promise.resolve(),
    });
    assert.deepEqual(getExplanationSession(7), {
      running: false,
      runningPassageIds: [],
      missingPassageIds: ["p1"],
      missingErrorCodes: { p1: "AI_PROFILE_NOT_AVAILABLE" },
    });

    // 第二轮：用户改好设置后补生成 p1，成功——原因码必须随缺失记录一起清掉，
    // 不许留一句过期的「模型没了」（这正是 carry 过滤存在的意义）
    const merged = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      onlyPassageIds: ["p1"],
      complete: completeOk,
      persist: () => Promise.resolve(),
    });
    assert.ok(merged);
    assert.deepEqual(getExplanationSession(7), {
      running: false,
      runningPassageIds: [],
      missingPassageIds: [],
      missingErrorCodes: {},
    });
  });

  it("写库失败：这轮 scope 内的组全部记为缺失，等补生成兜底", async () => {
    const merged = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: completeOk,
      persist: () => Promise.reject(new Error("db locked")),
    });
    assert.equal(merged, null);
    assert.deepEqual(getExplanationSession(7)?.missingPassageIds.sort(), ["p1", "p2"]);
    assert.equal(getExplanationSession(7)?.running, false);
  });

  it("同卷已有一轮在跑时直接返回 null，不重入", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked: CompleteStructured = async (opts) => {
      await gate;
      return completeOk(opts);
    };
    const first = runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: blocked,
      persist: () => Promise.resolve(),
    });
    assert.equal(getExplanationSession(7)?.running, true);
    assert.deepEqual(getExplanationSession(7)?.runningPassageIds.slice().sort(), ["p1", "p2"]);
    const second = await runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      complete: completeOk,
      persist: () => Promise.resolve(),
    });
    assert.equal(second, null);
    release();
    assert.ok(await first);
    assert.equal(getExplanationSession(7)?.running, false);
    assert.deepEqual(getExplanationSession(7)?.runningPassageIds, []);
  });

  it("补生成单组时 runningPassageIds 只含被点名的组", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked: CompleteStructured = async (opts) => {
      await gate;
      return completeOk(opts);
    };
    const run = runExplanationSession({
      paperId: 7,
      quiz: makeQuiz(),
      onlyPassageIds: ["p2"],
      complete: blocked,
      persist: () => Promise.resolve(),
    });
    assert.deepEqual(getExplanationSession(7)?.runningPassageIds, ["p2"]);
    release();
    await run;
    assert.deepEqual(getExplanationSession(7)?.runningPassageIds, []);
  });
});
