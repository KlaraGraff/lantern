import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCancelPayload,
  buildCompleteTextPayload,
  extractJson,
  unwrapText,
} from "../src/quiz/transport.ts";
import {
  answerCheckSchema,
  generatedExplanationsSchema,
} from "../src/quiz/schemas.ts";

// transport.ts 的契约测试。completeText/completeStructured/cancelRequest 本身在
// 最外层调用 Tauri 的 invoke()（Node 测试环境没有 IPC 桥，也没有
// --experimental-test-module-mocks 可用来打桩，见 generate.ts 头部注释的同一
// 权衡——实测过：Node 里直接调用真实 invoke() 会因为缺 `window` 直接抛错）——
// 这里只测它们内部用到的纯函数（unwrapText、extractJson、组装 invoke 负载的
// buildCompleteTextPayload/buildCancelPayload）和下游校验用的 zod schema，
// 不测 invoke 调用本身。

describe("unwrapText · 后端返回形状兼容", () => {
  it("兼容 { text } 形状", () => {
    assert.equal(unwrapText({ text: "hello" }), "hello");
  });

  it("兼容裸字符串形状", () => {
    assert.equal(unwrapText("hello"), "hello");
  });

  it("既不是字符串也没有 text 字段时抛错", () => {
    assert.throws(() => unwrapText({ foo: "bar" }));
    assert.throws(() => unwrapText(null));
    assert.throws(() => unwrapText(42));
  });
});

describe("buildCompleteTextPayload · requestId 接入 ai_cancel 取消通道", () => {
  const baseOpts = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

  it("未显式传 requestId 时内部兜底生成一个非空值——后端参数必填，负载不能缺席", () => {
    const payload = buildCompleteTextPayload(baseOpts);
    assert.equal(typeof payload.requestId, "string");
    assert.ok(payload.requestId.length > 0);
  });

  it("显式传 requestId 时原样透传，不被内部生成的值覆盖", () => {
    const payload = buildCompleteTextPayload({ ...baseOpts, requestId: "fixed-request-id" });
    assert.equal(payload.requestId, "fixed-request-id");
  });

  it("两次都不传 requestId 时各自生成不同句柄（每次请求独立可取消）", () => {
    const a = buildCompleteTextPayload(baseOpts);
    const b = buildCompleteTextPayload(baseOpts);
    assert.notEqual(a.requestId, b.requestId);
  });

  it("其余字段照常透传，cache 缺省为 false", () => {
    const payload = buildCompleteTextPayload(baseOpts);
    assert.deepEqual(payload.messages, baseOpts.messages);
    assert.equal(payload.maxTokens, 100);
    assert.equal(payload.cache, false);
  });

  // profileId 是「出题模型硬指定」上线的那根线——负载里丢了它，整个功能就静默
  // 退化成自动路由，且上层测试全测不出来（generate.ts 的透传测试只走 mock complete，
  // 摸不到真实负载）。这两条直接钉住负载形状。
  it("传 profileId 时原样进入负载（出题模型硬指定的唯一通道）", () => {
    const payload = buildCompleteTextPayload({ ...baseOpts, profileId: "profile-x" });
    assert.equal(payload.profileId, "profile-x");
  });

  it("不传 profileId 时负载里是 undefined（JSON 序列化会丢掉键，后端收到 None = 跟随自动路由）", () => {
    const payload = buildCompleteTextPayload(baseOpts);
    assert.equal(payload.profileId, undefined);
  });
});

describe("buildCancelPayload · ai_cancel 负载形状", () => {
  it("原样透传 requestId", () => {
    assert.deepEqual(buildCancelPayload("abc-123"), { requestId: "abc-123" });
  });
});

describe("extractJson · 模型输出容错", () => {
  it("纯 JSON 原样返回", () => {
    assert.equal(extractJson('{"a":1}'), '{"a":1}');
  });

  it("剥离 ```json 围栏", () => {
    const text = '这是结果：\n```json\n{"a":1}\n```\n谢谢';
    assert.equal(extractJson(text), '{"a":1}');
  });

  it("剥离无语言标注的围栏", () => {
    const text = '```\n{"a":1}\n```';
    assert.equal(extractJson(text), '{"a":1}');
  });

  it("没有围栏时从散文里抠出第一个完整 JSON 对象", () => {
    const text = '好的，这是答案：{"a":1} 希望有帮助';
    assert.equal(extractJson(text), '{"a":1}');
  });
});

describe("generatedExplanationsSchema · 阶段二真实形状载荷解析", () => {
  const base = {
    readingExplanations: [
      {
        questionIndex: 0,
        stemTranslation: "题干翻译",
        howToSolve: "解题路径",
        wordNote: "词卡",
        options: [{ label: "A", meaning: "含义", note: "note" }],
      },
    ],
    grammarExplanations: [
      {
        questionIndex: 0,
        sentenceTranslation: "整句翻译",
        grammarPoints: ["现在完成时"],
        reasoning: ["step1"],
        wrongForms: [{ form: "x", note: "错因" }],
        wordMeaning: "词义",
      },
    ],
  };

  it("answerDispute 缺省（没给这个字段）能解析通过", () => {
    const result = generatedExplanationsSchema.parse(base);
    assert.equal(result.readingExplanations[0].answerDispute, undefined);
    assert.equal(result.grammarExplanations[0].answerDispute, undefined);
  });

  it("answerDispute:null（模型表示「没有异议」的常见输出）能解析通过", () => {
    const payload = {
      readingExplanations: [{ ...base.readingExplanations[0], answerDispute: null }],
      grammarExplanations: [{ ...base.grammarExplanations[0], answerDispute: null }],
    };
    const result = generatedExplanationsSchema.parse(payload);
    assert.equal(result.readingExplanations[0].answerDispute, null);
    assert.equal(result.grammarExplanations[0].answerDispute, null);
  });

  it("answerDispute 给了字符串（举旗说明）也能解析通过", () => {
    const payload = {
      readingExplanations: [{ ...base.readingExplanations[0], answerDispute: "答案存疑" }],
      grammarExplanations: base.grammarExplanations,
    };
    const result = generatedExplanationsSchema.parse(payload);
    assert.equal(result.readingExplanations[0].answerDispute, "答案存疑");
  });
});

describe("answerCheckSchema · 明答校验容错解析", () => {
  it("选项字母给小写 b 也能解析通过并归一化成大写", () => {
    const result = answerCheckSchema.parse({
      readingAnswers: [{ questionIndex: 0, answer: "b" }],
      grammarAnswers: [],
    });
    assert.equal(result.readingAnswers[0].answer, "B");
  });

  it('选项字母带尾部标点（"B."）也能解析通过并归一化', () => {
    const result = answerCheckSchema.parse({
      readingAnswers: [{ questionIndex: 0, answer: "B." }],
      grammarAnswers: [],
    });
    assert.equal(result.readingAnswers[0].answer, "B");
  });

  it("选项字母带首尾空格也能解析通过", () => {
    const result = answerCheckSchema.parse({
      readingAnswers: [{ questionIndex: 0, answer: " c " }],
      grammarAnswers: [],
    });
    assert.equal(result.readingAnswers[0].answer, "C");
  });

  it("缺省 grammarAnswers 字段时默认为空数组，不拒收整个载荷", () => {
    const result = answerCheckSchema.parse({
      readingAnswers: [{ questionIndex: 0, answer: "A" }],
    });
    assert.deepEqual(result.grammarAnswers, []);
  });
});
