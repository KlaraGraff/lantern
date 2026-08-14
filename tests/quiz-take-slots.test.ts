import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveSlots } from "../src/pages/quiz/take-slots.ts";
import type { GenerationSessionState } from "../src/pages/quiz/generation-session.ts";
import type { Quiz, QuizConfig, QuizGenerationPlan, QuizWord } from "../src/quiz/types.ts";

// 渐进发卷做题屏的槽位推导（docs/impls/quiz-progressive-delivery.md §五）。
// 核心语义：open = 本篇 done 且前面每篇都 done（按篇序解锁，与生成先后无关）；
// pending/failed 的分界只看「会话是否在跑且该篇未终局」——重启后没有会话，
// 未完成篇一律当 failed（可重生成）。

const config: QuizConfig = {
  difficulty: "cet6",
  types: ["reading"],
  materialSource: "ai-original",
  model: "test-model",
  maskedCheck: true,
};

const w = (word: string): QuizWord => ({ word, origin: "today" });

function makeQuiz(status: Quiz["status"], plan?: QuizGenerationPlan): Quiz {
  return {
    id: 1,
    createdAt: "2026-08-13T00:00:00.000Z",
    status,
    config,
    words: [],
    passages: [
      { id: "p1", title: "One", paragraphs: ["a"], targetWords: ["alpha"] },
      { id: "p2", title: "Two", paragraphs: ["b"], targetWords: ["beta"] },
    ],
    readingQuestions: [],
    grammarQuestions: [],
    generation: plan,
  };
}

function makeSession(overrides: Partial<GenerationSessionState>): GenerationSessionState {
  return {
    running: true,
    stage: "articles",
    articles: [],
    paperId: 1,
    error: null,
    errorCode: null,
    revision: 0,
    ...overrides,
  };
}

describe("deriveSlots", () => {
  it("ready 卷（无生成计划）：全部篇 open，按 passages 顺序", () => {
    const slots = deriveSlots(makeQuiz("ready"), undefined);
    assert.deepEqual(slots.map((s) => s.state), ["open", "open"]);
    assert.deepEqual(slots.map((s) => s.passage?.id), ["p1", "p2"]);
  });

  it("前篇 done 即 open；后篇在生成中是 pending", () => {
    const plan: QuizGenerationPlan = {
      groups: [
        { words: [w("alpha")], state: "done", passageId: "p1" },
        { words: [w("beta"), w("gamma")], state: "pending" },
      ],
    };
    const session = makeSession({ articles: [{ wordCount: 1, step: "done" }, { wordCount: 2, step: "writing" }] });
    const slots = deriveSlots(makeQuiz("generating", plan), session);
    assert.deepEqual(slots.map((s) => s.state), ["open", "pending"]);
    assert.equal(slots[0].passage?.id, "p1");
    assert.equal(slots[0].step, undefined);
    assert.equal(slots[1].passage, undefined);
    assert.equal(slots[1].wordCount, 2);
    assert.equal(slots[1].step, "writing");
  });

  it("pending 槽位带活阶段：checking/regenerating 原样透出，瞬时的 pending 归入 writing", () => {
    const plan: QuizGenerationPlan = {
      groups: [
        { words: [w("alpha")], state: "pending" },
        { words: [w("beta")], state: "pending" },
        { words: [w("gamma")], state: "pending" },
      ],
    };
    const session = makeSession({
      articles: [
        { wordCount: 1, step: "checking" },
        { wordCount: 1, step: "regenerating" },
        { wordCount: 1, step: "pending" },
      ],
    });
    const slots = deriveSlots(makeQuiz("generating", plan), session);
    assert.deepEqual(slots.map((s) => s.state), ["pending", "pending", "pending"]);
    assert.deepEqual(slots.map((s) => s.step), ["checking", "regenerating", "writing"]);
  });

  it("锁的是做题顺序：第 2 篇先生成好，第 1 篇没好时它是 locked 不是 open", () => {
    const plan: QuizGenerationPlan = {
      groups: [
        { words: [w("alpha")], state: "pending" },
        { words: [w("beta")], state: "done", passageId: "p2" },
      ],
    };
    const session = makeSession({ articles: [{ wordCount: 1, step: "writing" }, { wordCount: 1, step: "done" }] });
    const slots = deriveSlots(makeQuiz("generating", plan), session);
    assert.deepEqual(slots.map((s) => s.state), ["pending", "locked"]);
    assert.equal(slots[1].passage?.id, "p2");
  });

  it("会话在跑但该篇已终局失败 → failed；其后的 done 篇仍是 locked", () => {
    const plan: QuizGenerationPlan = {
      groups: [
        { words: [w("alpha")], state: "failed", errorCode: "AI_STREAM_FAILED" },
        { words: [w("beta")], state: "done", passageId: "p2" },
      ],
    };
    const session = makeSession({ articles: [{ wordCount: 1, step: "failed" }, { wordCount: 1, step: "done" }] });
    const slots = deriveSlots(makeQuiz("generating", plan), session);
    assert.deepEqual(slots.map((s) => s.state), ["failed", "locked"]);
  });

  it("重启冷启动（无会话）：未完成篇一律 failed，不管计划里记的是 pending 还是 failed", () => {
    const plan: QuizGenerationPlan = {
      groups: [
        { words: [w("alpha")], state: "done", passageId: "p1" },
        { words: [w("beta")], state: "pending" },
        { words: [w("gamma")], state: "failed" },
      ],
    };
    const slots = deriveSlots(makeQuiz("generating", plan), undefined);
    assert.deepEqual(slots.map((s) => s.state), ["open", "failed", "failed"]);
  });

  it("done 但 passageId 在卷面里找不到（数据异常）按未完成处理，不产出空 open 篇", () => {
    const plan: QuizGenerationPlan = {
      groups: [{ words: [w("alpha")], state: "done", passageId: "ghost" }],
    };
    const slots = deriveSlots(makeQuiz("generating", plan), undefined);
    assert.deepEqual(slots.map((s) => s.state), ["failed"]);
  });
});
