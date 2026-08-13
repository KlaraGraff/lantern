import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArticleOutcome, ArticleStep, CompleteStructured, GenerateProgress } from "../src/quiz/generate.ts";
import { generateArticle, generateExplanations, generateQuiz, regroupForExplanations } from "../src/quiz/generate.ts";
import {
  answerCheckSchema,
  generatedExplanationsSchema,
  generatedPaperStage1Schema,
  maskedCheckVerdictSchema,
} from "../src/quiz/schemas.ts";
import type { GrammarFillQuestion, Quiz, QuizConfig, ReadingQuestion } from "../src/quiz/types.ts";

// 两阶段生成编排测试（docs/impls/cijuan-merge.md §二.6）。generate.ts 里发请求的
// completeStructured 走 Tauri invoke，Node 测试环境没有 IPC 桥；这里用
// generateQuiz/generateExplanations 新增的 `complete` 注入点传测试替身，按
// opts.schema 的引用相等性分辨这是「出题」「明答校验」「遮词自检」还是「重出」调用
// （四种调用各自的 messages 内容也不同，必要时也按内容判断，如区分 writing vs redo）。
//
// completeStructured 的返回形状是 { data, requestMessage, rawResponse }（缓存链路
// 复审新增，见 src/quiz/transport.ts）——测试替身一律用 structured() 包一层；
// generateQuiz 的返回形状同样变成 { quiz, traces, articles }（articles 是渐进
// 发卷的按篇结算单元，见 generate.ts 的 ArticleOutcome）。

const config: QuizConfig = {
  difficulty: "cet6",
  types: ["reading", "grammarFill"],
  materialSource: "ai-original",
  model: "test-model",
  maskedCheck: true,
}

const words = [
  { word: "subsidy", origin: "today" as const },
  { word: "advocate", origin: "today" as const },
]

/** completeStructured 新返回形状的测试替身包装：{ data, requestMessage, rawResponse } */
function structured<T>(
  data: T,
  requestMessage = "stub-request",
  rawResponse = "stub-response",
): { data: T; requestMessage: string; rawResponse: string } {
  return { data, requestMessage, rawResponse }
}

/** 阶段一「出题」调用的固定返回：一篇文章、一道阅读题（B 对）、一道语法题 */
const stage1Paper = {
  passages: [{ title: "Demo", paragraphs: ["p1"], targetWords: ["subsidy", "advocate"] }],
  readingQuestions: [
    {
      passageIndex: 0,
      targetWord: "subsidy",
      stem: "stem0",
      options: [
        { label: "A", text: "wrong" },
        { label: "B", text: "right" },
      ],
      answer: "B",
      sourceParagraph: 1,
      sourceQuote: "p1",
    },
    {
      passageIndex: 0,
      targetWord: "subsidy",
      stem: "stem1",
      options: [
        { label: "A", text: "right" },
        { label: "B", text: "wrong" },
      ],
      answer: "A",
      sourceParagraph: 1,
      sourceQuote: "p1",
    },
  ],
  grammarQuestions: [{ targetWord: "advocate", sentence: "sentence0", hint: "advocate", answer: "have advocated" }],
}

/** 只出阅读题的一篇文章：每个目标词一道题、标准答案一律 A，stem-<词> 便于断言定位 */
function makeReadingPaper(targetWords: string[]) {
  return {
    passages: [{ title: `Demo-${targetWords[0]}`, paragraphs: ["p1"], targetWords }],
    readingQuestions: targetWords.map((w) => ({
      passageIndex: 0,
      targetWord: w,
      stem: `stem-${w}`,
      options: [
        { label: "A", text: "right" },
        { label: "B", text: "wrong" },
      ],
      answer: "A",
      sourceParagraph: 1,
      sourceQuote: "p1",
    })),
    grammarQuestions: [],
  }
}

describe("generateQuiz · 明答校验 + 遮词自检全部通过", () => {
  it("不触发重出，直接按阶段一出题结果发卷，并返回可续写的 trace", async () => {
    const events: GenerateProgress[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      if (opts.schema === generatedPaperStage1Schema) return structured(structuredClone(stage1Paper))
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        // 遮词后模型没把握（confident=false）——不算失败
        return structured({ verdicts: [{ questionIndex: 0, answeredWithoutWord: "B", confident: false }] })
      }
      throw new Error(`未预期的 schema 调用：${JSON.stringify(opts.messages[0]?.content).slice(0, 50)}`)
    }) as CompleteStructured

    const { quiz, traces } = await generateQuiz({ words, config, onProgress: (e) => events.push(e), complete })

    assert.equal(quiz.readingQuestions.length, 2)
    assert.equal(quiz.readingQuestions[0].stem, "stem0")
    assert.equal(quiz.grammarQuestions[0].sentence, "sentence0")
    // 流水线化后的事件流：拆词 → 报出分篇词数 → 这一篇 写稿/校验/完成 → 发卷；
    // 校验全过，序列里不该出现 regenerating（deepEqual 顺带守住这一点）
    assert.deepEqual(events, [
      { type: "splitting" },
      { type: "split", articles: [{ wordCount: 2 }] },
      { type: "article", index: 0, step: "writing" },
      { type: "article", index: 0, step: "checking" },
      { type: "article", index: 0, step: "done" },
      { type: "done" },
    ])

    // traces 只在内存里，一组一条，键为该组文章的 passageId
    assert.equal(traces.length, 1)
    assert.equal(traces[0].passageId, quiz.passages[0].id)
    assert.equal(traces[0].stage1UserMessage, "stub-request")
    assert.equal(traces[0].stage1RawResponse, "stub-response")
  })

  it("maskedCheck 关闭时不发起遮词自检请求", async () => {
    const complete: CompleteStructured = (async (opts: any) => {
      if (opts.schema === generatedPaperStage1Schema) return structured(structuredClone(stage1Paper))
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        throw new Error("maskedCheck=false 时不该调用遮词自检")
      }
      throw new Error("未预期的调用")
    }) as CompleteStructured

    const { quiz } = await generateQuiz({
      words,
      config: { ...config, maskedCheck: false },
      complete,
    })
    assert.equal(quiz.readingQuestions.length, 2)
  })
})

describe("generateQuiz · 明答校验与遮词自检失败题合并重出", () => {
  it("两边失败集合按题目下标去重合并，各自类型分别重出，止损一轮", async () => {
    const events: GenerateProgress[] = []
    // 顺带捕获每次调用的 profileId：这是唯一驱动到重出调用的用例，出题模型
    // 硬指定必须连重出这一跳也带上（generate.ts redoFailedQuestions 内的调用）
    const capturedProfileIds: (string | undefined)[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      capturedProfileIds.push(opts.profileId)
      const firstContent = String(opts.messages[0]?.content ?? "")

      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) {
          // 重出调用：读题 0、1 与语法题 0 都要重出
          return structured({
            passages: [],
            readingQuestions: [
              { passageIndex: 0, targetWord: "subsidy", stem: "redone-stem0", options: [{ label: "A", text: "x" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
              { passageIndex: 0, targetWord: "subsidy", stem: "redone-stem1", options: [{ label: "A", text: "x" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
            ],
            grammarQuestions: [
              { targetWord: "advocate", sentence: "redone-sentence0", hint: "advocate", answer: "redone answer" },
            ],
          })
        }
        // rawResponse 须是真实 JSON：runAnswerCheck 现在要从这段文本里剥掉 answer
        // 字段再续写（问题 1 修复），"stub-response" 这种占位字符串会让剥离解析
        // 失败、降级为「这组跳过明答校验」——语法题的失败判定只来自明答校验，
        // 假 rawResponse 会让本用例对语法题的断言失真。
        return structured(structuredClone(stage1Paper), "stub-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        // 阅读题 0 答案对不上（应为 B，模型自己重做选了 A）；语法题 0 也对不上
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "A" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "wrong form" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        // 遮词后阅读题 0（与明答校验重叠，去重）和阅读题 1（新增）都仍能自信答对
        return structured({
          verdicts: [
            { questionIndex: 0, answeredWithoutWord: "B", confident: true },
            { questionIndex: 1, answeredWithoutWord: "A", confident: true },
          ],
        })
      }
      throw new Error(`未预期的 schema 调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const { quiz } = await generateQuiz({
      words,
      config,
      onProgress: (e) => events.push(e),
      complete,
      profileId: "profile-pinned",
    })

    assert.ok(
      events.some((e) => e.type === "article" && e.step === "regenerating"),
      "两边任一失败都该触发重出",
    )
    // 出题、明答校验、遮词自检、重出四跳全部带上同一个 profileId，重出不许漏
    assert.ok(capturedProfileIds.length >= 4, "本用例应至少驱动 4 次底层调用（含重出）")
    assert.ok(
      capturedProfileIds.every((id) => id === "profile-pinned"),
      "重出调用也必须带上钉住的 profileId",
    )
    // 去重合并：readingFailedIdx 应为 {0,1}（明答校验的 0 与遮词自检的 0、1 合并后只有两个，
    // 不是三个），因此两道阅读题都应被重出题覆盖
    assert.equal(quiz.readingQuestions[0].stem, "redone-stem0")
    assert.equal(quiz.readingQuestions[1].stem, "redone-stem1")
    assert.equal(quiz.grammarQuestions[0].sentence, "redone-sentence0")
    assert.equal(quiz.grammarQuestions[0].answer, "redone answer")
  })

  it("重出调用失败时保留原题，不阻塞整卷", async () => {
    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) throw new Error("模拟重出调用失败")
        // 真实 JSON rawResponse，理由同上一用例
        return structured(structuredClone(stage1Paper), "stub-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [{ questionIndex: 0, answer: "A" }], // 与标准答案 B 不一致 → 失败
          grammarAnswers: [],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        return structured({ verdicts: [] })
      }
      throw new Error("未预期的调用")
    }) as CompleteStructured

    const { quiz } = await generateQuiz({ words, config, complete })
    // 重出失败 → 保留阶段一原题
    assert.equal(quiz.readingQuestions[0].stem, "stem0")
    assert.equal(quiz.readingQuestions[0].answer, "B")
  })

  it("重出响应顺序被打乱时，仍按 targetWord 配对写回，不按位置对位（错词护栏）", async () => {
    // 两道阅读题目标词不同，都判失败触发重出；重出响应刻意把顺序倒过来
    // （advocate 排第一、subsidy 排第二）——若按位置对位会把 subsidy 题错误地
    // 配上 advocate 的重出结果，错词池会记错词
    const twoWordPaper = {
      passages: [{ title: "Demo", paragraphs: ["p1"], targetWords: ["subsidy", "advocate"] }],
      readingQuestions: [
        { passageIndex: 0, targetWord: "subsidy", stem: "stem-subsidy", options: [{ label: "A", text: "a" }, { label: "B", text: "b" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
        { passageIndex: 0, targetWord: "advocate", stem: "stem-advocate", options: [{ label: "A", text: "a" }, { label: "B", text: "b" }], answer: "B", sourceParagraph: 1, sourceQuote: "p1" },
      ],
      grammarQuestions: [],
    }
    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) {
          return structured({
            passages: [],
            readingQuestions: [
              { passageIndex: 0, targetWord: "advocate", stem: "redone-advocate", options: [{ label: "A", text: "x" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
              { passageIndex: 0, targetWord: "subsidy", stem: "redone-subsidy", options: [{ label: "A", text: "x" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
            ],
            grammarQuestions: [],
          })
        }
        // 真实 JSON rawResponse，理由同前——本用例的两道阅读题失败全靠明答校验判定
        return structured(structuredClone(twoWordPaper), "stub-request", JSON.stringify(twoWordPaper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" }, // 与标准答案 A 不一致 → 失败
            { questionIndex: 1, answer: "A" }, // 与标准答案 B 不一致 → 失败
          ],
          grammarAnswers: [],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) return structured({ verdicts: [] })
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const { quiz } = await generateQuiz({ words, config, complete })

    const subsidyQ = quiz.readingQuestions.find((q) => q.targetWord === "subsidy")!
    const advocateQ = quiz.readingQuestions.find((q) => q.targetWord === "advocate")!
    assert.equal(subsidyQ.stem, "redone-subsidy")
    assert.equal(advocateQ.stem, "redone-advocate")
  })
})

describe("generateQuiz · 多篇卷：逐篇校验/重出后仍按原顺序拼回整卷", () => {
  it("13 词拆成 [7,6] 两篇：各篇明答校验与遮词自检的篇内失败下标合并去重、各自重出，拼卷后精确覆盖正确的全局题位", async () => {
    // 流水线化之前，遮词自检与重出是全卷单次调用，明答校验的组内下标要重映射为
    // 全局下标；现在三道工序全部逐篇进行，天然都是篇内下标。本用例守住的是
    // 「篇内失败判定（两门合并去重）→ 篇内重出写回 → 按组序拼卷」的端到端正确性：
    // 每篇的失败题必须落回它在整卷里的原始题位，不许串篇、不许错位。
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const allTargetWords = [...group1Words, ...group2Words]
    const manyWords = allTargetWords.map((word) => ({ word, origin: "today" as const }))
    // 只出阅读题：语法题的失败判定只走明答校验，与本用例要验证的两门合并无关
    const readingConfig: QuizConfig = { ...config, types: ["reading"] }

    const group1Paper = makeReadingPaper(group1Words)
    const group2Paper = makeReadingPaper(group2Words)

    // 期望被重出覆盖的全局题位为 {2,5,8,10}：
    // - 第 1 篇（全局 0~6）：明答校验篇内 idx2 失败 → 全局 2（alphaC）；
    //   遮词自检篇内 idx5 失败 → 全局 5（alphaF，与明答校验不重叠）
    // - 第 2 篇（全局 7~12）：明答校验篇内 idx1 失败 → 全局 8（betaB）；
    //   遮词自检篇内 idx1 失败 → 与 betaB 重叠，验证篇内去重后只重出一道；
    //   遮词自检篇内 idx3 失败 → 全局 10（betaD）
    const failedGlobalIdx = [2, 5, 8, 10]

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) {
          // 重出改为逐篇调用：靠提示词里的文章标题分辨是哪一篇，各自只返回本篇的失败题
          const failedForGroup = firstContent.includes("Demo-alphaA")
            ? ["alphaC", "alphaF"]
            : ["betaB", "betaD"]
          return structured({
            passages: [],
            readingQuestions: failedForGroup.map((w) => ({
              passageIndex: 0,
              targetWord: w,
              stem: `redone-${w}`,
              options: [{ label: "A", text: "x" }],
              answer: "A",
              sourceParagraph: 1,
              sourceQuote: "p1",
            })),
            grammarQuestions: [],
          })
        }
        if (firstContent.includes("alphaA")) {
          return structured(structuredClone(group1Paper), "req-group1", JSON.stringify(group1Paper))
        }
        return structured(structuredClone(group2Paper), "req-group2", JSON.stringify(group2Paper))
      }
      if (opts.schema === answerCheckSchema) {
        // 靠回放的 stage1UserMessage（messages[0]）区分是哪一篇的续写
        if (firstContent === "req-group1") {
          // 第 1 篇 7 题（篇内 idx 0~6），篇内 idx2（alphaC）失败
          return structured({
            readingAnswers: group1Words.map((_, i) => ({ questionIndex: i, answer: i === 2 ? "B" : "A" })),
            grammarAnswers: [],
          })
        }
        // 第 2 篇 6 题（篇内 idx 0~5），篇内 idx1（betaB）失败
        return structured({
          readingAnswers: group2Words.map((_, i) => ({ questionIndex: i, answer: i === 1 ? "B" : "A" })),
          grammarAnswers: [],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        // 遮词自检同样逐篇调用，questionIndex 是篇内下标。提示词里各题的目标词
        // 已被遮成 ████，词面认不出是哪一篇——只能靠题数分辨：第 1 篇 7 题
        // （存在「## 题 6」），第 2 篇只有 6 题。
        if (firstContent.includes("## 题 6")) {
          // 第 1 篇：篇内 idx5（alphaF）遮词后仍自信答对 → 失败
          return structured({
            verdicts: [{ questionIndex: 5, answeredWithoutWord: "A", confident: true }],
          })
        }
        // 第 2 篇：篇内 idx1（betaB，与明答校验重叠）与 idx3（betaD）失败
        return structured({
          verdicts: [
            { questionIndex: 1, answeredWithoutWord: "A", confident: true },
            { questionIndex: 3, answeredWithoutWord: "A", confident: true },
          ],
        })
      }
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const { quiz } = await generateQuiz({ words: manyWords, config: readingConfig, complete })

    assert.equal(quiz.readingQuestions.length, 13)
    quiz.readingQuestions.forEach((q, i) => {
      assert.equal(q.targetWord, allTargetWords[i], `第 ${i} 题目标词应保持原顺序`)
      if (failedGlobalIdx.includes(i)) {
        assert.equal(q.stem, `redone-${allTargetWords[i]}`, `全局下标 ${i} 应被重出覆盖`)
      } else {
        assert.equal(q.stem, `stem-${allTargetWords[i]}`, `全局下标 ${i} 不该被重出覆盖`)
      }
    })
  })
})

describe("generateQuiz · 质检门调用失败时降级为空失败集（不丢弃已生成的卷子）", () => {
  it("明答校验与遮词自检都抛错时，仍正常发卷、不触发重出", async () => {
    const events: GenerateProgress[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      if (opts.schema === generatedPaperStage1Schema) return structured(structuredClone(stage1Paper))
      if (opts.schema === answerCheckSchema) throw new Error("模拟明答校验调用失败（网络异常）")
      if (opts.schema === maskedCheckVerdictSchema) throw new Error("模拟遮词自检调用失败")
      throw new Error("未预期的调用")
    }) as CompleteStructured

    const { quiz } = await generateQuiz({ words, config, onProgress: (e) => events.push(e), complete })

    assert.equal(quiz.readingQuestions.length, 2)
    assert.equal(quiz.readingQuestions[0].stem, "stem0") // 未被重出覆盖：质检门失效退回无质检行为
    assert.ok(
      !events.some((e) => e.type === "article" && e.step === "regenerating"),
      "两个质检门都失效时不该误判出失败题触发重出",
    )
  })
})

describe("generateQuiz · 续写缓存链路", () => {
  it("阶段一出题调用带 cache:true；明答校验续写原样回放 trace 文本并带 cache:true；遮词自检不带 cache", async () => {
    const calls: { schema: unknown; messages: any[]; cache?: boolean }[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      calls.push({ schema: opts.schema, messages: opts.messages, cache: opts.cache })
      if (opts.schema === generatedPaperStage1Schema) {
        const firstContent = String(opts.messages[0]?.content ?? "")
        if (firstContent.includes("没有通过质检")) return structured(structuredClone(stage1Paper))
        // rawResponse 须是真实 JSON（且带 answer 字段）：这是本用例要验证的对象——
        // runAnswerCheck 从这段文本里剥掉 answer 后才拿去续写（问题 1 修复）
        return structured(structuredClone(stage1Paper), "stage1-request-verbatim", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        return structured({ verdicts: [] })
      }
      throw new Error("未预期的调用")
    }) as CompleteStructured

    await generateQuiz({ words, config, complete })

    const writingCall = calls.find((c) => c.schema === generatedPaperStage1Schema)!
    assert.equal(writingCall.cache, true, "阶段一出题调用要带 cache:true，让明答校验续写命中前缀")

    const answerCheckCall = calls.find((c) => c.schema === answerCheckSchema)!
    assert.equal(answerCheckCall.cache, true)
    assert.equal(answerCheckCall.messages.length, 3, "续写形态：阶段一 user + assistant 原文 + 校验指令")
    assert.equal(answerCheckCall.messages[0].role, "user")
    assert.equal(answerCheckCall.messages[0].content, "stage1-request-verbatim", "user 轮须与阶段一请求逐字节一致，缓存前缀才能命中")
    assert.equal(answerCheckCall.messages[1].role, "assistant")
    // 问题 1 修复：assistant 轮不能原样回放 stage1RawResponse——那样模型会看到
    // 自己两轮前写的答案，「独立重解」名存实亡。这里断言剥离已生效：既不含
    // "answer" 字符串，逐题解析后也确认阅读、语法两类都没有 answer 键。
    const strippedAssistant = String(answerCheckCall.messages[1].content)
    assert.ok(!strippedAssistant.includes('"answer"'), "assistant 轮不应带答案字段")
    const strippedParsed = JSON.parse(strippedAssistant)
    for (const q of strippedParsed.readingQuestions) {
      assert.ok(!("answer" in q), "阅读题不该带 answer 字段")
    }
    for (const q of strippedParsed.grammarQuestions) {
      assert.ok(!("answer" in q), "语法题不该带 answer 字段")
    }
    assert.equal(answerCheckCall.messages[2].role, "user")

    const maskedCall = calls.find((c) => c.schema === maskedCheckVerdictSchema)!
    assert.equal(maskedCall.cache, undefined, "遮词自检文本与阶段一前缀不同，蹭不到缓存，不带 cache")
  })
})

describe("generateQuiz/generateExplanations · profileId 出题模型硬指定透传", () => {
  it("generateQuiz 传入 profileId 时，阶段一出题调用与解析生成调用都带上原样的 profileId", async () => {
    const capturedProfileIds: (string | undefined)[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      capturedProfileIds.push(opts.profileId)
      if (opts.schema === generatedPaperStage1Schema) {
        return structured(structuredClone(stage1Paper), "stub-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        return structured({ verdicts: [] })
      }
      throw new Error("未预期的调用")
    }) as CompleteStructured

    await generateQuiz({ words, config, complete, profileId: "profile-pinned" })

    assert.ok(capturedProfileIds.length >= 3, "至少应观察到出题/明答校验/遮词自检三次调用")
    assert.ok(
      capturedProfileIds.every((id) => id === "profile-pinned"),
      "每一次底层 complete 调用都该带上同一个 profileId",
    )
  })

  it("generateQuiz 不传 profileId 时，底层调用的 profileId 是 undefined（跟随自动路由）", async () => {
    const capturedProfileIds: (string | undefined)[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      capturedProfileIds.push(opts.profileId)
      if (opts.schema === generatedPaperStage1Schema) {
        return structured(structuredClone(stage1Paper), "stub-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) return structured({ verdicts: [] })
      throw new Error("未预期的调用")
    }) as CompleteStructured

    await generateQuiz({ words, config, complete })

    assert.ok(capturedProfileIds.length > 0, "应至少发生过一次调用")
    assert.ok(capturedProfileIds.every((id) => id === undefined), "不传 profileId 时不该凭空带出一个值")
  })

  it("generateExplanations 传入 profileId 时，解析生成调用带上原样的 profileId", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [{ id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p1")],
      grammarQuestions: [gq("gq1", "p1")],
      status: "ready",
    }
    let capturedProfileId: string | undefined
    const complete: CompleteStructured = (async (opts: any) => {
      capturedProfileId = opts.profileId
      return structured({
        readingExplanations: [
          { questionIndex: 0, stemTranslation: "x", howToSolve: "y", wordNote: "z", options: [] },
        ],
        grammarExplanations: [
          { questionIndex: 0, sentenceTranslation: "x", grammarPoints: [], reasoning: [], wrongForms: [], wordMeaning: "x" },
        ],
      })
    }) as CompleteStructured

    await generateExplanations({ quiz, complete, profileId: "profile-pinned" })

    assert.equal(capturedProfileId, "profile-pinned")
  })
})

describe("regroupForExplanations", () => {
  it("按 passageId 把阅读题与语法题重新分组", () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [
        { id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] },
        { id: "p2", title: "T2", paragraphs: ["b"], targetWords: ["advocate"] },
      ],
      readingQuestions: [
        rq("rq1", "p1"),
        rq("rq2", "p2"),
      ],
      grammarQuestions: [gq("gq1", "p1")],
      status: "ready",
    }
    const groups = regroupForExplanations(quiz)
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].readingQuestions.map((q) => q.id), ["rq1"])
    assert.deepEqual(groups[0].grammarQuestions.map((q) => q.id), ["gq1"])
    assert.deepEqual(groups[1].readingQuestions.map((q) => q.id), ["rq2"])
    assert.deepEqual(groups[1].grammarQuestions.map((q) => q.id), [])
  })
})

describe("generatedExplanationsSchema · 缺字段容错（问题 2 修复）", () => {
  it("回复缺 grammarExplanations 字段时按 .default([]) 通过，不整组拒收", () => {
    // 纯阅读卷（config.types 不含 grammarFill）时模型可能整个省略 grammarExplanations
    // 键——缺省应等价于「没有语法题要报」，而不是让整组解析因为缺一个数组字段被拒
    const parsed = generatedExplanationsSchema.parse({
      readingExplanations: [
        {
          questionIndex: 0,
          stemTranslation: "题干翻译",
          howToSolve: "解题路径",
          wordNote: "词卡",
          options: [],
        },
      ],
      // 没有 grammarExplanations 键
    })
    assert.deepEqual(parsed.grammarExplanations, [])
  })

  it("回复缺 readingExplanations 字段时同样按 .default([]) 通过", () => {
    const parsed = generatedExplanationsSchema.parse({
      grammarExplanations: [
        {
          questionIndex: 0,
          sentenceTranslation: "整句翻译",
          grammarPoints: ["现在完成时"],
          reasoning: ["step1"],
          wrongForms: [],
          wordMeaning: "倡导",
        },
      ],
      // 没有 readingExplanations 键
    })
    assert.deepEqual(parsed.readingExplanations, [])
  })

  it("端到端：generateExplanations 收到缺 grammarExplanations 的回复仍正常合并，不报 missingPassageIds", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config: { ...config, types: ["reading"] },
      words,
      passages: [{ id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p1")],
      grammarQuestions: [],
      status: "ready",
    }
    const complete: CompleteStructured = (async () => {
      // 测试替身直接返回 data，不会像真实 completeStructured 那样过一遍
      // schema.parse——这里手动过一遍 generatedExplanationsSchema，模拟「模型
      // 省略了 grammarExplanations 键（纯阅读卷场景）→ zod 用 .default([]) 补齐」
      // 这一真实链路，否则测试替身直接把 undefined 传下去，验证不到 schema 容错。
      const raw = {
        readingExplanations: [
          { questionIndex: 0, stemTranslation: "题干翻译", howToSolve: "解题路径", wordNote: "词卡", options: [] },
        ],
        // 没有 grammarExplanations 键
      }
      return structured(generatedExplanationsSchema.parse(raw))
    }) as CompleteStructured

    const result = await generateExplanations({ quiz, complete })
    assert.deepEqual(result.missingPassageIds, [])
    assert.equal(result.quiz.readingQuestions[0].stemTranslation, "题干翻译")
  })
})

describe("generateExplanations", () => {
  it("按 questionIndex 把解析字段合并回对应题目，answerDispute 只在给出时才写入", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [{ id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p1")],
      grammarQuestions: [gq("gq1", "p1")],
      status: "ready",
    }
    const complete: CompleteStructured = (async (opts: any) => {
      assert.equal(opts.schema, generatedExplanationsSchema)
      return structured({
        readingExplanations: [
          {
            questionIndex: 0,
            stemTranslation: "题干翻译",
            howToSolve: "解题路径",
            wordNote: "词卡",
            options: [
              { label: "A", meaning: "含义A", note: "note A" },
              { label: "B", meaning: "含义B", note: "note B" },
            ],
            // 没有 answerDispute
          },
        ],
        grammarExplanations: [
          {
            questionIndex: 0,
            sentenceTranslation: "整句翻译",
            grammarPoints: ["现在完成时"],
            reasoning: ["step1", "step2"],
            wrongForms: [{ form: "advocate", note: "漏了 have" }],
            wordMeaning: "倡导",
            answerDispute: "答案存疑：也可能接受被动形态",
          },
        ],
      })
    }) as CompleteStructured

    // 不传 traces：走冷启动重建路径（无续写凭据时的兜底，行为不变）
    const result = await generateExplanations({ quiz, complete })
    assert.deepEqual(result.missingPassageIds, [])
    const readingOut = result.quiz.readingQuestions[0]
    assert.equal(readingOut.stemTranslation, "题干翻译")
    assert.equal(readingOut.answerDispute, undefined)
    const grammarOut = result.quiz.grammarQuestions[0]
    assert.equal(grammarOut.sentenceTranslation, "整句翻译")
    assert.equal(grammarOut.answerDispute, "答案存疑：也可能接受被动形态")
  })

  it("模型给 answerDispute:null（无异议）时不拒收整组解析", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [{ id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p1")],
      grammarQuestions: [],
      status: "ready",
    }
    const complete: CompleteStructured = (async () => {
      return structured({
        readingExplanations: [
          {
            questionIndex: 0,
            stemTranslation: "题干翻译",
            howToSolve: "解题路径",
            wordNote: "词卡",
            options: [],
            answerDispute: null,
          },
        ],
        grammarExplanations: [],
      })
    }) as CompleteStructured

    const result = await generateExplanations({ quiz, complete })
    assert.deepEqual(result.missingPassageIds, [])
    assert.equal(result.quiz.readingQuestions[0].answerDispute, undefined)
  })

  it("某一组解析生成失败时不抛出，报告 missingPassageIds，其它组照常合并", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [
        { id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] },
        { id: "p2", title: "T2", paragraphs: ["b"], targetWords: ["advocate"] },
      ],
      readingQuestions: [rq("rq1", "p1"), rq("rq2", "p2")],
      grammarQuestions: [],
      status: "ready",
    }
    const complete: CompleteStructured = (async (opts: any) => {
      const isP1 = String(opts.messages[1]?.content ?? "").includes('"title":"T1"')
      if (isP1) throw new Error("模拟这一组解析生成失败")
      return structured({
        readingExplanations: [{ questionIndex: 0, stemTranslation: "T2 解析", howToSolve: "x", wordNote: "y", options: [] }],
        grammarExplanations: [],
      })
    }) as CompleteStructured

    const result = await generateExplanations({ quiz, complete })
    assert.deepEqual(result.missingPassageIds, ["p1"])
    assert.equal(result.quiz.readingQuestions[0].stemTranslation, undefined) // p1 组失败，原题不变
    assert.equal(result.quiz.readingQuestions[1].stemTranslation, "T2 解析")
    // 「模拟这一组解析生成失败」不是注册表里的错误码，识别不出就不记原因
    assert.deepEqual(result.missingErrorCodes, {})
  })

  it("失败原因是注册表认得的 AI 错误码时（如钉住的出题模型被删），按组记进 missingErrorCodes", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [
        { id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] },
        { id: "p2", title: "T2", paragraphs: ["b"], targetWords: ["advocate"] },
      ],
      readingQuestions: [rq("rq1", "p1"), rq("rq2", "p2")],
      grammarQuestions: [],
      status: "ready",
    }
    const complete: CompleteStructured = (async (opts: any) => {
      const isP1 = String(opts.messages[1]?.content ?? "").includes('"title":"T1"')
      // 后端 AppError 序列化成裸字符串，前端拿到的是 message 含错误码的 Error
      if (isP1) throw new Error("AI_PROFILE_NOT_AVAILABLE")
      return structured({
        readingExplanations: [{ questionIndex: 0, stemTranslation: "T2 解析", howToSolve: "x", wordNote: "y", options: [] }],
        grammarExplanations: [],
      })
    }) as CompleteStructured

    const result = await generateExplanations({ quiz, complete })
    assert.deepEqual(result.missingPassageIds, ["p1"])
    assert.deepEqual(result.missingErrorCodes, { p1: "AI_PROFILE_NOT_AVAILABLE" })
  })

  it("传入 traces 时按 passageId 原样回放阶段一原文续写（不重建 JSON），带 cache:true", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [{ id: "p1", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p1")],
      grammarQuestions: [],
      status: "ready",
    }
    const traces = [{ passageId: "p1", stage1UserMessage: "原始阶段一请求文本", stage1RawResponse: "原始阶段一回复文本" }]
    let capturedMessages: any[] = []
    let capturedCache: boolean | undefined
    const complete: CompleteStructured = (async (opts: any) => {
      capturedMessages = opts.messages
      capturedCache = opts.cache
      return structured({
        readingExplanations: [{ questionIndex: 0, stemTranslation: "x", howToSolve: "y", wordNote: "z", options: [] }],
        grammarExplanations: [],
      })
    }) as CompleteStructured

    await generateExplanations({ quiz, traces, complete })

    assert.equal(capturedMessages.length, 3)
    assert.deepEqual(capturedMessages[0], { role: "user", content: "原始阶段一请求文本" })
    assert.deepEqual(capturedMessages[1], { role: "assistant", content: "原始阶段一回复文本" })
    assert.equal(capturedMessages[2].role, "user")
    assert.equal(capturedCache, true)
  })

  it("传入 traces 但某组没有对应 trace（如新增补生成组）时退回重建路径，不报错", async () => {
    const quiz: Quiz = {
      createdAt: "2026-01-01T00:00:00.000Z",
      config,
      words,
      passages: [{ id: "p-no-trace", title: "T1", paragraphs: ["a"], targetWords: ["subsidy"] }],
      readingQuestions: [rq("rq1", "p-no-trace")],
      grammarQuestions: [],
      status: "ready",
    }
    let capturedMessages: any[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      capturedMessages = opts.messages
      return structured({
        readingExplanations: [{ questionIndex: 0, stemTranslation: "x", howToSolve: "y", wordNote: "z", options: [] }],
        grammarExplanations: [],
      })
    }) as CompleteStructured

    const result = await generateExplanations({ quiz, traces: [], complete })
    assert.deepEqual(result.missingPassageIds, [])
    // 走重建路径：assistant 回合是 toStage1Paper 序列化出的 JSON，不是某条 trace 原文
    assert.equal(capturedMessages.length, 3)
    assert.ok(capturedMessages[1].content.includes('"title":"T1"'))
  })
})

describe("generateQuiz · requestRegistry 取消句柄注册表（docs/impls/cijuan-merge.md 步骤 4）", () => {
  it("每次底层 complete 调用前用全新 uuid 登记进 registry，settle 后立刻摘除，不留残留", async () => {
    const registry = new Set<string>()
    const seenRequestIds: string[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      assert.ok(opts.requestId, "每次调用都应带上 requestId")
      assert.ok(registry.has(opts.requestId), "调用发起的那一刻，它的 id 必须已经登记进 registry")
      seenRequestIds.push(opts.requestId)
      // rawResponse 须是真实 JSON：明答校验续写要从这段文本里剥答案（见 stripStage1Answers），
      // 不这样写的话 runAnswerCheck 会在 JSON.parse 处静默降级、根本不会发起第二次调用，
      // 这个用例就验不到「至少三次调用」。
      if (opts.schema === generatedPaperStage1Schema) {
        return structured(structuredClone(stage1Paper), "stage1-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) return structured({ verdicts: [] })
      throw new Error(`未预期的 schema 调用：${JSON.stringify(opts.messages[0]?.content).slice(0, 50)}`)
    }) as CompleteStructured

    await generateQuiz({ words, config, complete, requestRegistry: registry })

    assert.equal(registry.size, 0, "全部请求都 settle 之后，registry 应该清空")
    assert.ok(seenRequestIds.length >= 3, "至少应观察到出题/明答校验/遮词自检三次调用")
    assert.equal(
      new Set(seenRequestIds).size,
      seenRequestIds.length,
      "同一个 requestId 绝不能跨请求复用——旧 id 若被下一次请求带上，会被后端那张已经摘掉记录的待取消表误杀",
    )
  })

  it("调用 reject 时也要在 finally 里把对应 id 从 registry 摘除", async () => {
    const registry = new Set<string>()
    let capturedDuringFailure: string | undefined
    const complete: CompleteStructured = (async (opts: any) => {
      if (opts.schema === generatedPaperStage1Schema) {
        capturedDuringFailure = opts.requestId
        throw new Error("模拟出题请求失败")
      }
      throw new Error("不该走到这里")
    }) as CompleteStructured

    await assert.rejects(() => generateQuiz({ words, config, complete, requestRegistry: registry }))

    assert.ok(capturedDuringFailure, "失败前应已拿到 requestId")
    assert.equal(registry.size, 0, "请求失败也要清理 registry，不留孤儿 id")
  })

  it("不传 requestRegistry 时不生成也不附带 requestId，交由更底层兜底", async () => {
    const capturedRequestIds: unknown[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      capturedRequestIds.push(opts.requestId)
      if (opts.schema === generatedPaperStage1Schema) {
        return structured(structuredClone(stage1Paper), "stage1-request", JSON.stringify(stage1Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [{ questionIndex: 0, answer: "have advocated" }],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) return structured({ verdicts: [] })
      throw new Error("未预期的调用")
    }) as CompleteStructured

    await generateQuiz({ words, config, complete })

    assert.ok(capturedRequestIds.length > 0, "应至少发生过一次调用")
    assert.ok(
      capturedRequestIds.every((id) => id === undefined),
      "不传 registry 时 generate.ts 自己不应该生成 requestId",
    )
  })
})

describe("generateQuiz · 每篇独立流水线（并发行为）", () => {
  it("一篇写完立刻进入自己的校验，不等另一篇写稿完成（无全卷阶段屏障）", async () => {
    // 编排目标：第 1 篇的明答校验必须在第 2 篇写稿完成之前就发起。
    // 做法：用门闩把第 2 篇的写稿挡住，直到观察到第 1 篇的明答校验调用才放行——
    // 流水线编排下这一定发生；若回归成「所有写稿完成才开始校验」的屏障式，
    // 第 1 篇的校验永远等不到、门闩只能靠 2 秒兜底放行，断言随即失败
    // （兜底保证回归时测试报错而不是挂死）。
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const manyWords = [...group1Words, ...group2Words].map((word) => ({ word, origin: "today" as const }))
    const group1Paper = makeReadingPaper(group1Words)
    const group2Paper = makeReadingPaper(group2Words)

    let releaseGroup2!: () => void
    const group2Gate = new Promise<void>((resolve) => {
      releaseGroup2 = resolve
    })
    let group2WriteFinished = false
    let checkStartedBeforeGroup2Write: boolean | null = null

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("alphaA")) {
          return structured(structuredClone(group1Paper), "req-group1", JSON.stringify(group1Paper))
        }
        await group2Gate
        group2WriteFinished = true
        return structured(structuredClone(group2Paper), "req-group2", JSON.stringify(group2Paper))
      }
      if (opts.schema === answerCheckSchema) {
        if (firstContent === "req-group1" && checkStartedBeforeGroup2Write === null) {
          checkStartedBeforeGroup2Write = !group2WriteFinished
          releaseGroup2()
        }
        const count = firstContent === "req-group1" ? group1Words.length : group2Words.length
        // 全部答对：本用例只看并发时序，不掺失败/重出
        return structured({
          readingAnswers: Array.from({ length: count }, (_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      }
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const failsafe = setTimeout(releaseGroup2, 2000)
    try {
      const { quiz } = await generateQuiz({
        words: manyWords,
        // maskedCheck 关掉：遮词自检与时序断言无关，少一类调用少一分干扰
        config: { ...config, types: ["reading"], maskedCheck: false },
        complete,
      })
      assert.equal(quiz.readingQuestions.length, 13)
    } finally {
      clearTimeout(failsafe)
    }

    assert.equal(
      checkStartedBeforeGroup2Write,
      true,
      "第 1 篇的明答校验应在第 2 篇写稿完成之前发起（流水线，无全卷屏障）",
    )
  })

})

describe("generateQuiz · 失败按篇隔离（渐进发卷语义，docs/impls/quiz-progressive-delivery.md §一.5）", () => {
  it("某篇写稿失败只标记该篇 failed，其余篇照常校验并进卷；失败篇的词不进覆盖结算", async () => {
    // 第 1 篇写稿直接失败；第 2 篇写稿被门闩挡到第 1 篇失败定局之后才返回——
    // 旧版共享中止闸在这个时序下会让第 2 篇跳过校验、整卷 reject；渐进发卷
    // 语义下第 2 篇必须照常发起明答校验、照常进卷（每一篇独立有价值）。
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const manyWords = [...group1Words, ...group2Words].map((word) => ({ word, origin: "today" as const }))
    const group2Paper = makeReadingPaper(group2Words)

    let releaseGroup2!: () => void
    const group2Gate = new Promise<void>((resolve) => {
      releaseGroup2 = resolve
    })
    let answerCheckCalls = 0
    const events: GenerateProgress[] = []

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("alphaA")) {
          // 先放行第 2 篇再抛：保证第 2 篇的写稿在第 1 篇失败已定局之后才返回
          releaseGroup2()
          throw new Error("模拟第 1 篇写稿失败")
        }
        await group2Gate
        return structured(structuredClone(group2Paper), "req-group2", JSON.stringify(group2Paper))
      }
      if (opts.schema === answerCheckSchema) {
        answerCheckCalls++
        return structured({
          readingAnswers: group2Words.map((_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      }
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const { quiz, articles } = await generateQuiz({
      words: manyWords,
      config: { ...config, types: ["reading"], maskedCheck: false },
      onProgress: (e) => events.push(e),
      complete,
    })

    assert.equal(answerCheckCalls, 1, "第 2 篇必须照常发起明答校验，不受第 1 篇失败牵连")
    // 卷面只装成功篇；失败篇的词不进覆盖结算（words 只剩 beta 组）
    assert.equal(quiz.passages.length, 1)
    assert.equal(quiz.passages[0].title, "Demo-betaA")
    assert.equal(quiz.readingQuestions.length, group2Words.length)
    assert.deepEqual(quiz.words.map((w) => w.word), group2Words)
    // 按篇产出：articles 保组序，第 1 篇 ok:false 且带原始错误与本组词（重生成要用）
    assert.equal(articles.length, 2)
    assert.equal(articles[0].ok, false)
    assert.equal(articles[0].index, 0)
    assert.deepEqual(articles[0].words.map((w) => w.word), group1Words)
    assert.ok(articles[0].error instanceof Error)
    assert.equal(articles[0].errorCode, null, "「模拟第 1 篇写稿失败」不是注册表里的错误码")
    assert.equal(articles[0].passage, null)
    assert.equal(articles[1].ok, true)
    assert.equal(articles[1].index, 1)
    assert.equal(articles[1].passage?.title, "Demo-betaA")
    // 失败篇的进度事件终态是 failed（生成中屏与做题页占位共用）
    assert.ok(events.some((e) => e.type === "article" && e.index === 0 && e.step === "failed"))
  })

  it("onArticle 在每条流水线 settle 时回调一次，成败都报", async () => {
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const manyWords = [...group1Words, ...group2Words].map((word) => ({ word, origin: "today" as const }))
    const group2Paper = makeReadingPaper(group2Words)

    const outcomes: ArticleOutcome[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("alphaA")) throw new Error("AI_PROFILE_NOT_AVAILABLE")
        return structured(structuredClone(group2Paper), "req-group2", JSON.stringify(group2Paper))
      }
      if (opts.schema === answerCheckSchema) {
        return structured({
          readingAnswers: group2Words.map((_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      }
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const { articles } = await generateQuiz({
      words: manyWords,
      config: { ...config, types: ["reading"], maskedCheck: false },
      onArticle: (o) => outcomes.push(o),
      complete,
    })

    assert.equal(outcomes.length, 2, "两条流水线各回调一次")
    assert.deepEqual(
      [...outcomes].sort((a, b) => a.index - b.index).map((o) => [o.index, o.ok]),
      [
        [0, false],
        [1, true],
      ],
    )
    // 注册表认得的错误码（钉住的出题模型被停用/删除）要随 outcome 上报
    const failedOutcome = outcomes.find((o) => !o.ok)!
    assert.equal(failedOutcome.errorCode, "AI_PROFILE_NOT_AVAILABLE")
    // 回调给出的就是返回值里同一份 outcome（引用一致，编排层落库不会拿到俩版本）
    for (const o of outcomes) assert.ok(articles.includes(o))
  })

  it("全部篇写稿都失败时仍 reject（保留生成失败屏路径），抛出组序在前的底层错误", async () => {
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const manyWords = [...group1Words, ...group2Words].map((word) => ({ word, origin: "today" as const }))

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        throw new Error(firstContent.includes("alphaA") ? "第 1 篇写稿失败" : "第 2 篇写稿失败")
      }
      throw new Error("全败时不该有任何校验调用")
    }) as CompleteStructured

    await assert.rejects(
      () =>
        generateQuiz({
          words: manyWords,
          config: { ...config, types: ["reading"], maskedCheck: false },
          complete,
        }),
      /第 1 篇写稿失败/,
    )
  })
})

describe("generateArticle · 单组流水线独立入口（继续生成/单篇重生成）", () => {
  it("走同一段 写稿→校验→重出 代码，index 原样进 outcome，重出结果写回", async () => {
    const groupWords = ["gammaA", "gammaB"]
    const paper = makeReadingPaper(groupWords)
    const steps: ArticleStep[] = []

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) {
          return structured({
            passages: [],
            readingQuestions: [
              { passageIndex: 0, targetWord: "gammaA", stem: "redone-gammaA", options: [{ label: "A", text: "x" }], answer: "A", sourceParagraph: 1, sourceQuote: "p1" },
            ],
            grammarQuestions: [],
          })
        }
        return structured(structuredClone(paper), "req-gamma", JSON.stringify(paper))
      }
      if (opts.schema === answerCheckSchema) {
        // 篇内 idx0 答案对不上 → 触发重出
        return structured({
          readingAnswers: [
            { questionIndex: 0, answer: "B" },
            { questionIndex: 1, answer: "A" },
          ],
          grammarAnswers: [],
        })
      }
      throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
    }) as CompleteStructured

    const outcome = await generateArticle({
      words: groupWords.map((word) => ({ word, origin: "today" as const })),
      config: { ...config, types: ["reading"], maskedCheck: false },
      index: 3,
      onStep: (s) => steps.push(s),
      complete,
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.index, 3, "重生成场景 index 传原篇位，进度与落库靠它对号")
    assert.equal(outcome.passage?.title, "Demo-gammaA")
    assert.equal(outcome.readingQuestions[0].stem, "redone-gammaA")
    assert.equal(outcome.readingQuestions[1].stem, "stem-gammaB")
    assert.deepEqual(steps, ["writing", "checking", "regenerating", "done"])
  })

  it("写稿失败产出 ok:false 的 outcome（不抛出），errorCode 识别注册表错误码", async () => {
    const steps: ArticleStep[] = []
    const complete: CompleteStructured = (async () => {
      throw new Error("AI_PROFILE_NOT_AVAILABLE")
    }) as CompleteStructured

    const outcome = await generateArticle({
      words: [{ word: "gammaA", origin: "today" as const }],
      config: { ...config, types: ["reading"], maskedCheck: false },
      onStep: (s) => steps.push(s),
      complete,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.index, 0, "省略 index 时按单篇卷记 0")
    assert.equal(outcome.errorCode, "AI_PROFILE_NOT_AVAILABLE")
    assert.deepEqual(outcome.words.map((w) => w.word), ["gammaA"])
    assert.deepEqual(steps, ["writing", "failed"])
  })
})

function rq(id: string, passageId: string): ReadingQuestion {
  return {
    id,
    type: "reading",
    passageId,
    targetWord: "subsidy",
    stem: "stem",
    options: [
      { label: "A", text: "a" },
      { label: "B", text: "b" },
    ],
    answer: "A",
    source: { passageId, paragraph: 1, quote: "q" },
  }
}

function gq(id: string, passageId: string): GrammarFillQuestion {
  return {
    id,
    type: "grammarFill",
    passageId,
    targetWord: "advocate",
    sentence: "sentence",
    hint: "advocate",
    answer: "have advocated",
  }
}
