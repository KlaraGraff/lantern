import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompleteStructured } from "../src/quiz/generate.ts";
import { generateExplanations, generateQuiz, regroupForExplanations } from "../src/quiz/generate.ts";
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
// generateQuiz 的返回形状同样变成 { quiz, traces }。

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

describe("generateQuiz · 明答校验 + 遮词自检全部通过", () => {
  it("不触发重出，直接按阶段一出题结果发卷，并返回可续写的 trace", async () => {
    const steps: string[] = []
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

    const { quiz, traces } = await generateQuiz({ words, config, onProgress: (s) => steps.push(s), complete })

    assert.equal(quiz.readingQuestions.length, 2)
    assert.equal(quiz.readingQuestions[0].stem, "stem0")
    assert.equal(quiz.grammarQuestions[0].sentence, "sentence0")
    assert.ok(!steps.includes("regenerating"), "校验全过不该进入重出步骤")
    assert.deepEqual(steps, ["splitting", "writing", "checking", "done"])

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
    const steps: string[] = []
    const complete: CompleteStructured = (async (opts: any) => {
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

    const { quiz } = await generateQuiz({ words, config, onProgress: (s) => steps.push(s), complete })

    assert.ok(steps.includes("regenerating"), "两边任一失败都该触发重出")
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

describe("generateQuiz · 多组时组内索引正确重映射为全局索引", () => {
  it("13 词拆成 [7,6] 两组：明答校验的组内失败下标（经 question id 映射）与遮词自检的全局失败下标合并后，仍精确对应到正确的全局题目", async () => {
    // 覆盖 generate.ts runAnswerCheck 里 group-local questionIndex → 全局下标的
    // 重映射（约 :228-268）：每组续写各自的对话，answerCheck 返回的 questionIndex
    // 是「这一组过滤后的子数组」下标，必须先按 question id 换算回整卷全局下标，
    // 才能和遮词自检本就是全局索引的失败集合正确合并、去重。
    const group1Words = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
    const group2Words = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
    const allTargetWords = [...group1Words, ...group2Words]
    const manyWords = allTargetWords.map((word) => ({ word, origin: "today" as const }))
    // 只出阅读题：语法题的失败判定只走明答校验，与本用例要验证的「组内→全局」
    // 重映射（明答校验 + 遮词自检合并）无关，关掉能让用例更聚焦
    const readingConfig: QuizConfig = { ...config, types: ["reading"] }

    const makePaper = (targetWords: string[]) => ({
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
    })
    const group1Paper = makePaper(group1Words)
    const group2Paper = makePaper(group2Words)

    // 全局失败下标（并集去重后）应为 {2,5,8,10}：
    // - group1（全局 0~6）：明答校验组内 idx2 失败 → 全局 2（alphaC）
    // - 遮词自检：全局 idx5 失败 → 全局 5（alphaF，group1 内，与明答校验不重叠）
    // - group2（全局 7~12）：明答校验组内 idx1 失败 → 全局 8（betaB）
    // - 遮词自检：全局 idx8 失败 → 与上面 betaB 重叠，验证去重后仍是同一个全局下标
    // - 遮词自检：全局 idx10 失败 → 全局 10（betaD，group2 内，与明答校验不重叠）
    const failedGlobalIdx = [2, 5, 8, 10]
    const failedWords = failedGlobalIdx.map((i) => allTargetWords[i])

    const complete: CompleteStructured = (async (opts: any) => {
      const firstContent = String(opts.messages[0]?.content ?? "")
      if (opts.schema === generatedPaperStage1Schema) {
        if (firstContent.includes("没有通过质检")) {
          return structured({
            passages: [],
            readingQuestions: failedWords.map((w) => ({
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
        // 靠回放的 stage1UserMessage（messages[0]）区分是哪一组的续写
        if (firstContent === "req-group1") {
          // group1 组内 7 题（local idx 0~6），组内 idx2（alphaC）失败 → 应映射为全局 2
          return structured({
            readingAnswers: group1Words.map((_, i) => ({ questionIndex: i, answer: i === 2 ? "B" : "A" })),
            grammarAnswers: [],
          })
        }
        // group2 组内 6 题（local idx 0~5），组内 idx1（betaB）失败 → 应映射为全局 8
        return structured({
          readingAnswers: group2Words.map((_, i) => ({ questionIndex: i, answer: i === 1 ? "B" : "A" })),
          grammarAnswers: [],
        })
      }
      if (opts.schema === maskedCheckVerdictSchema) {
        return structured({
          verdicts: [5, 8, 10].map((i) => ({ questionIndex: i, answeredWithoutWord: "A", confident: true })),
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
    const steps: string[] = []
    const complete: CompleteStructured = (async (opts: any) => {
      if (opts.schema === generatedPaperStage1Schema) return structured(structuredClone(stage1Paper))
      if (opts.schema === answerCheckSchema) throw new Error("模拟明答校验调用失败（网络异常）")
      if (opts.schema === maskedCheckVerdictSchema) throw new Error("模拟遮词自检调用失败")
      throw new Error("未预期的调用")
    }) as CompleteStructured

    const { quiz } = await generateQuiz({ words, config, onProgress: (s) => steps.push(s), complete })

    assert.equal(quiz.readingQuestions.length, 2)
    assert.equal(quiz.readingQuestions[0].stem, "stem0") // 未被重出覆盖：质检门失效退回无质检行为
    assert.ok(!steps.includes("regenerating"), "两个质检门都失效时不该误判出失败题触发重出")
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
