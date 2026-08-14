import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionMessages,
  classifyExtractError,
  mergeExtractedWords,
} from "../src/quiz/image-words.ts";

// 图片取词的纯逻辑层（src/quiz/image-words.ts）。extractWordsFromImage 走真实
// invoke()，Node 环境没有 IPC 桥（同 quiz-transport.test.ts 头部注释的权衡），
// 这里测消息构造、合并去重、错误分类三个纯函数；SetupTab 的队列/高亮是 UI，
// 靠人工验收。

describe("buildExtractionMessages · 提取请求的消息形状", () => {
  it("一条 user_image（data URI 原文）+ 一条收尾 user 提示词", () => {
    const uri = "data:image/jpeg;base64,AAA";
    const messages = buildExtractionMessages(uri);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { role: "user_image", content: uri });
    assert.equal(messages[1].role, "user");
    // completeStructured 要求以 user 结尾（schema 附块拼在这条上）
    assert.ok(messages[1].content.length > 0);
  });
});

describe("mergeExtractedWords · 与输入框既有文本的合并", () => {
  it("空框：新词一行一个成为全文，appendedText 即全文", () => {
    const r = mergeExtractedWords("", ["alpha", "beta"]);
    assert.equal(r.nextRaw, "alpha\nbeta");
    assert.equal(r.appendedText, "alpha\nbeta");
    assert.equal(r.addedCount, 2);
    assert.equal(r.dupCount, 0);
  });

  it("非空框：修掉尾部空白后换行接上，nextRaw 以 appendedText 结尾（高亮定位依赖这一点）", () => {
    const r = mergeExtractedWords("alpha\n", ["beta", "gamma"]);
    assert.equal(r.nextRaw, "alpha\nbeta\ngamma");
    assert.equal(r.appendedText, "beta\ngamma");
    assert.ok(r.nextRaw.endsWith(r.appendedText));
    assert.equal(r.nextRaw.length - r.appendedText.length, "alpha\n".length);
  });

  it("与既有词重复（大小写不敏感、按 parseWordInput 口径切分）计入 dupCount 且不再加", () => {
    const r = mergeExtractedWords("Alpha, beta", ["alpha", "gamma"]);
    assert.equal(r.nextRaw, "Alpha, beta\ngamma");
    assert.equal(r.addedCount, 1);
    assert.equal(r.dupCount, 1);
  });

  it("批内自身重复静默合并，不计入 dupCount", () => {
    const r = mergeExtractedWords("", ["alpha", "Alpha", "alpha"]);
    assert.equal(r.nextRaw, "alpha");
    assert.equal(r.addedCount, 1);
    assert.equal(r.dupCount, 0);
  });

  it("模型返回的条目先过 parseWordInput 归一化：行首序号剥掉后再查重", () => {
    const r = mergeExtractedWords("apple\nbanana", ["1. apple", "2. cherry"]);
    assert.equal(r.nextRaw, "apple\nbanana\ncherry");
    assert.equal(r.addedCount, 1);
    assert.equal(r.dupCount, 1);
  });

  it("一个条目里塞了多个词（含分隔符）按 parseWordInput 口径拆开各自处理", () => {
    const r = mergeExtractedWords("apple", ["banana, cherry", "Apple"]);
    assert.equal(r.nextRaw, "apple\nbanana\ncherry");
    assert.equal(r.addedCount, 2);
    assert.equal(r.dupCount, 1);
  });

  it("空串/纯符号/无英文字母的条目直接丢弃；词内空白压成单个空格", () => {
    const r = mergeExtractedWords("", ["  in   particular  ", "", "123", "！！"]);
    assert.equal(r.nextRaw, "in particular");
    assert.equal(r.addedCount, 1);
    assert.equal(r.dupCount, 0);
  });

  it("没有新词时 nextRaw 原样返回（不动用户的尾部空白）", () => {
    const r = mergeExtractedWords("alpha\n\n", ["alpha"]);
    assert.equal(r.nextRaw, "alpha\n\n");
    assert.equal(r.appendedText, "");
    assert.equal(r.addedCount, 0);
    assert.equal(r.dupCount, 1);
  });
});

describe("classifyExtractError · 识别失败分类", () => {
  it("带已知 AI 错误码的错误归 ai，码原样带出", () => {
    const f = classifyExtractError(new Error("failed: AI_PROFILE_NOT_AVAILABLE profile gone"));
    assert.deepEqual(f, { kind: "ai", code: "AI_PROFILE_NOT_AVAILABLE" });
  });

  it("错误串点名 image/vision/multimodal 归 vision", () => {
    assert.deepEqual(classifyExtractError(new Error("this model does not support image input")), { kind: "vision" });
    assert.deepEqual(classifyExtractError(new Error("Vision not enabled")), { kind: "vision" });
    assert.deepEqual(classifyExtractError(new Error("multimodal content rejected")), { kind: "vision" });
  });

  it("对图片请求的 provider 400/413/422 归 vision（已知形状正确、体积很小的请求）", () => {
    for (const status of [400, 413, 422]) {
      assert.deepEqual(
        classifyExtractError(new Error(`AI_PROVIDER_HTTP type=api code=- status=${status}`)),
        { kind: "vision" },
        `status=${status}`,
      );
    }
  });

  it("provider 的其他状态码不归 vision", () => {
    assert.deepEqual(classifyExtractError(new Error("AI_PROVIDER_HTTP type=api code=- status=429")), {
      kind: "generic",
    });
    assert.deepEqual(classifyExtractError(new Error("AI_PROVIDER_HTTP type=api code=- status=500")), {
      kind: "generic",
    });
  });

  it("AI 错误码优先于 vision 关键词（码有稳定文案，启发式只兜底）", () => {
    const f = classifyExtractError(new Error("AI_KEYS_COOLING_DOWN while sending image"));
    assert.deepEqual(f, { kind: "ai", code: "AI_KEYS_COOLING_DOWN" });
  });

  it("网络/超时等其余错误归 generic", () => {
    assert.deepEqual(classifyExtractError(new Error("fetch failed")), { kind: "generic" });
    assert.deepEqual(classifyExtractError("weird non-error value"), { kind: "generic" });
  });
});
