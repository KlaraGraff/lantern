import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompleteStructured } from "../src/quiz/generate.ts";
import { answerCheckSchema, generatedPaperStage1Schema } from "../src/quiz/schemas.ts";
import type { Passage, Quiz, QuizConfig, QuizWord, ReadingQuestion } from "../src/quiz/types.ts";
import type { GenerationIo } from "../src/pages/quiz/generation-session.ts";
import {
  cancelGenerationSession,
  getNewPaperGeneration,
  getPaperGeneration,
  regenerateArticles,
  resetGenerationSessions,
  startGenerationSession,
} from "../src/pages/quiz/generation-session.ts";
import type { runExplanationSession } from "../src/pages/quiz/explanation-session.ts";

// 渐进发卷会话的编排/落库测试（docs/impls/quiz-progressive-delivery.md §四）。
// 三个注入点全部换成测试替身：complete（AI 调用）、io（三条 DB 写路径）、
// runExplanations（逐篇解析——大多数用例只关心「何时被叫、拿到什么」，
// 阶段二内部另有 quiz-generate.test.ts 覆盖）。
// startGenerationSession / regenerateArticles 都是 fire-and-forget，
// 断言一律先 waitFor 等到目标状态，不猜时序。

const config: QuizConfig = {
  difficulty: "cet6",
  types: ["reading"],
  materialSource: "ai-original",
  model: "test-model",
  maskedCheck: false,
}

// splitWords 对 13 词确定性拆成 [7, 6] 两组（与 quiz-generate.test.ts 同一约定）
const alphaWords = ["alphaA", "alphaB", "alphaC", "alphaD", "alphaE", "alphaF", "alphaG"]
const betaWords = ["betaA", "betaB", "betaC", "betaD", "betaE", "betaF"]
const twoGroupWords: QuizWord[] = [...alphaWords, ...betaWords].map((word) => ({
  word,
  origin: "today" as const,
}))

function structured<T>(data: T) {
  return { data, requestMessage: "stub-request", rawResponse: "stub-response" }
}

/** 只出阅读题的一篇文章：每词一题、答案全 A（与 quiz-generate.test.ts 的同名夹具一致） */
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

/** 两组卷的通用 complete 替身：按内容认组，答案校验全过；组可各挂一道门闩 */
function makeComplete(opts?: {
  alphaGate?: Promise<void>
  betaGate?: Promise<void>
  alphaError?: string
  betaError?: string
}): CompleteStructured {
  return (async (callOpts: any) => {
    const firstContent = String(callOpts.messages[0]?.content ?? "")
    const isAlpha = firstContent.includes("alphaA")
    if (callOpts.schema === generatedPaperStage1Schema) {
      if (isAlpha) {
        if (opts?.alphaError) throw new Error(opts.alphaError)
        await opts?.alphaGate
        return structured(structuredClone(makeReadingPaper(alphaWords)))
      }
      if (opts?.betaError) throw new Error(opts.betaError)
      await opts?.betaGate
      return structured(structuredClone(makeReadingPaper(betaWords)))
    }
    if (callOpts.schema === answerCheckSchema) {
      const n = isAlpha ? alphaWords.length : betaWords.length
      return structured({
        readingAnswers: Array.from({ length: n }, (_, i) => ({ questionIndex: i, answer: "A" })),
        grammarAnswers: [],
      })
    }
    throw new Error(`未预期的调用：${firstContent.slice(0, 50)}`)
  }) as CompleteStructured
}

interface IoCalls {
  create: any[]
  update: any[]
  content: { id: number; contentJson: string }[]
  deleted: number[]
}

function makeIo(): { io: GenerationIo; calls: IoCalls } {
  const calls: IoCalls = { create: [], update: [], content: [], deleted: [] }
  let nextId = 101
  const io: GenerationIo = {
    createPaper: async (args) => {
      calls.create.push(args)
      return nextId++
    },
    updateGeneration: async (args) => {
      calls.update.push(args)
    },
    updateContent: async (id, contentJson) => {
      calls.content.push({ id, contentJson })
    },
    deletePaper: async (id) => {
      calls.deleted.push(id)
    },
  }
  return { io, calls }
}

/** 无操作的解析替身，只记录每次调用的关键参数 */
function makeExplanations() {
  const calls: { paperId: number; onlyPassageIds?: string[]; traceCount: number }[] = []
  const run = (async (opts: any) => {
    calls.push({
      paperId: opts.paperId,
      onlyPassageIds: opts.onlyPassageIds,
      traceCount: opts.traces?.length ?? 0,
    })
    return null
  }) as typeof runExplanationSession
  return { run, calls }
}

async function waitFor(cond: () => boolean, label: string) {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  assert.fail(`waitFor 超时：${label}`)
}

function parseContent(json: string): { passages: Passage[]; readingQuestions: ReadingQuestion[] } {
  return JSON.parse(json)
}

describe("generation-session · 单组卷退化为旧行为", () => {
  it("唯一一组就绪即全组就绪：直接建 ready 卷、无生成计划，解析随建卷排队一次", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    const groupWords = ["gammaA", "gammaB"]
    const complete = (async (callOpts: any) => {
      if (callOpts.schema === generatedPaperStage1Schema)
        return structured(structuredClone(makeReadingPaper(groupWords)))
      if (callOpts.schema === answerCheckSchema)
        return structured({
          readingAnswers: groupWords.map((_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      throw new Error("未预期的调用")
    }) as CompleteStructured

    startGenerationSession({
      words: groupWords.map((word) => ({ word, origin: "today" as const })),
      config,
      complete,
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
    const state = getNewPaperGeneration()!
    assert.equal(state.error, null)
    assert.equal(state.paperId, 101)
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].status, "ready")
    assert.equal(calls.create[0].generationJson, null)
    const content = parseContent(calls.create[0].contentJson)
    assert.equal(content.passages[0].title, "Demo-gammaA")
    assert.deepEqual(
      JSON.parse(calls.create[0].wordsJson).map((w: QuizWord) => w.word),
      groupWords,
    )
    assert.equal(calls.update.length, 0, "建卷即终态，不该再有结构化 UPDATE")

    await waitFor(() => expl.calls.length === 1, "解析排队")
    assert.equal(expl.calls[0].paperId, 101)
    assert.deepEqual(expl.calls[0].onlyPassageIds, [content.passages[0].id])
    assert.equal(expl.calls[0].traceCount, 1)
  })
})

describe("generation-session · 首篇就绪即进卷（任意组序）", () => {
  it("第 2 组先就绪 → 建 generating 卷（组1 记 pending）；第 1 组补齐后按组序翻 ready", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    let releaseAlpha!: () => void
    const alphaGate = new Promise<void>((r) => {
      releaseAlpha = r
    })

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ alphaGate }),
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => calls.create.length === 1, "首篇（beta 组）建卷")
    assert.equal(calls.create[0].status, "generating")
    const plan = JSON.parse(calls.create[0].generationJson)
    assert.equal(plan.groups.length, 2)
    assert.equal(plan.groups[0].state, "pending")
    assert.deepEqual(plan.groups[0].words.map((w: QuizWord) => w.word), alphaWords)
    assert.equal(plan.groups[1].state, "done")
    assert.ok(plan.groups[1].passageId)
    // 卷面此刻只有 beta 篇；覆盖结算也只累计 beta 组
    const createdContent = parseContent(calls.create[0].contentJson)
    assert.deepEqual(createdContent.passages.map((p) => p.title), ["Demo-betaA"])
    assert.deepEqual(
      JSON.parse(calls.create[0].wordsJson).map((w: QuizWord) => w.word),
      betaWords,
    )
    assert.equal(getNewPaperGeneration()?.paperId, 101, "订阅方据此导航")

    releaseAlpha()
    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
    const last = calls.update.at(-1)!
    assert.equal(last.id, 101)
    assert.equal(last.status, "ready")
    assert.equal(last.generationJson, null, "全部就绪后行数据与非渐进卷同形")
    // 篇序 = 组序（与按篇解锁一致），不是就绪先后
    const finalContent = parseContent(last.contentJson)
    assert.deepEqual(finalContent.passages.map((p) => p.title), ["Demo-alphaA", "Demo-betaA"])
    assert.deepEqual(
      JSON.parse(last.wordsJson).map((w: QuizWord) => w.word),
      [...alphaWords, ...betaWords],
    )
    // 两篇各排一轮解析，且都在建卷之后（paperId 已就绪）
    await waitFor(() => expl.calls.length === 2, "两轮解析排队")
    assert.ok(expl.calls.every((c) => c.paperId === 101))
  })

  it("某组失败：建卷时计划记 failed + 错误码，会话不整体报错，卷面留 generating", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ alphaError: "AI_PROFILE_NOT_AVAILABLE" }),
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
    const state = getNewPaperGeneration()!
    assert.equal(state.error, null, "有成功篇就不算整体失败")
    assert.equal(state.paperId, 101)
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].status, "generating")
    const plan = JSON.parse(
      (calls.update.at(-1)?.generationJson ?? calls.create[0].generationJson) as string,
    )
    assert.equal(plan.groups[0].state, "failed")
    assert.equal(plan.groups[0].errorCode, "AI_PROFILE_NOT_AVAILABLE")
    assert.equal(plan.groups[1].state, "done")
    assert.equal(expl.calls.length, 1, "失败篇没有解析可排")
  })

  it("全部组都失败：不建卷，错误码上屏（生成失败屏路径保留）", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({
        alphaError: "AI_PROFILE_NOT_AVAILABLE",
        betaError: "AI_PROFILE_NOT_AVAILABLE",
      }),
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
    const state = getNewPaperGeneration()!
    assert.equal(state.paperId, null)
    assert.ok(state.error)
    assert.equal(state.errorCode, "AI_PROFILE_NOT_AVAILABLE")
    assert.equal(calls.create.length, 0, "全败不建卷")
    assert.equal(expl.calls.length, 0)
  })

  it("建卷前取消：首篇随后就绪也不建卷、不导航", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    let releaseAlpha!: () => void
    let releaseBeta!: () => void
    const alphaGate = new Promise<void>((r) => {
      releaseAlpha = r
    })
    const betaGate = new Promise<void>((r) => {
      releaseBeta = r
    })

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ alphaGate, betaGate }),
      io,
      runExplanations: expl.run,
    })

    assert.equal(getNewPaperGeneration()?.running, true)
    cancelGenerationSession()
    assert.equal(getNewPaperGeneration(), null, "取消即离场，出卷页回到 idle")

    // 取消后才放行两组——在飞的 Promise 照样 settle，写链必须一步都不走
    releaseAlpha()
    releaseBeta()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.create.length, 0)
    assert.equal(calls.update.length, 0)
    assert.equal(expl.calls.length, 0)
  })
})

describe("generation-session · 解析写回与新篇落库的竞态", () => {
  it("解析基于旧快照写回时，后落的新篇不被覆盖（persist 合并进权威卷）", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    let releaseBeta!: () => void
    const betaGate = new Promise<void>((r) => {
      releaseBeta = r
    })
    let releaseExpl!: () => void
    const explGate = new Promise<void>((r) => {
      releaseExpl = r
    })
    let explStarted!: () => void
    const explStartedGate = new Promise<void>((r) => {
      explStarted = r
    })

    // 解析替身：快照开跑时的卷（只有 alpha 篇），压到 beta 篇落库之后才 persist
    const runExplanations = (async (opts: any) => {
      const snapshot = structuredClone(opts.quiz) as Quiz
      explStarted()
      await explGate
      snapshot.readingQuestions[0].stemTranslation = "解析A"
      await opts.persist(opts.paperId, snapshot)
      return snapshot
    }) as typeof runExplanationSession

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ betaGate }),
      io,
      runExplanations,
    })

    // alpha 先就绪建卷，解析拿到只含 alpha 的快照
    await explStartedGate
    assert.equal(parseContent(calls.create[0].contentJson).passages.length, 1)

    // beta 落库（全组就绪 → ready），然后才放行解析的 persist
    releaseBeta()
    await waitFor(() => calls.update.some((u) => u.status === "ready"), "beta 篇落库")
    releaseExpl()

    // beta 篇的解析紧随其后也会 persist（content 可能瞬间从 0 跳到 2），
    // 条件用 >=，断言只看第一笔（alpha 那轮）
    await waitFor(() => calls.content.length >= 1, "解析写回")
    const final = parseContent(calls.content[0].contentJson)
    assert.deepEqual(
      final.passages.map((p) => p.title),
      ["Demo-alphaA", "Demo-betaA"],
      "旧快照 persist 不得抹掉后落的 beta 篇",
    )
    assert.equal(
      final.readingQuestions.find((q) => q.targetWord === "alphaA")?.stemTranslation,
      "解析A",
    )
    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
  })
})

describe("generation-session · 建卷后的入口与恢复", () => {
  it("建卷后（后台还在生成剩余篇）再点生成：起新会话建第二张卷，旧卷照常收尾", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    let releaseAlpha!: () => void
    const alphaGate = new Promise<void>((r) => {
      releaseAlpha = r
    })

    // 第一卷：beta 先就绪建卷（101），alpha 组被门闩压住——会话保持 running
    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ alphaGate }),
      io,
      runExplanations: expl.run,
    })
    await waitFor(() => calls.create.length === 1, "第一卷建卷")
    assert.equal(getNewPaperGeneration()?.running, true, "剩余篇还在生成")

    // 用户被导航去做题后返回出卷页，再点生成——不许是无声的死键
    const gammaWords = ["gammaA", "gammaB"]
    const completeGamma = (async (callOpts: any) => {
      if (callOpts.schema === generatedPaperStage1Schema)
        return structured(structuredClone(makeReadingPaper(gammaWords)))
      if (callOpts.schema === answerCheckSchema)
        return structured({
          readingAnswers: gammaWords.map((_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      throw new Error("未预期的调用")
    }) as CompleteStructured
    startGenerationSession({
      words: gammaWords.map((word) => ({ word, origin: "today" as const })),
      config,
      complete: completeGamma,
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => getNewPaperGeneration()?.paperId === 102, "第二卷建卷并上屏")
    assert.equal(calls.create.length, 2)

    // 旧卷的 alpha 组放行：写进 101，不受新会话影响
    releaseAlpha()
    await waitFor(() => calls.update.some((u) => u.id === 101 && u.status === "ready"), "旧卷收尾")
  })

  it("结构落库吞错后（内存领先 DB），重生成入口重发落库拉齐，而不是无声返回", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    let releaseAlpha!: () => void
    const alphaGate = new Promise<void>((r) => {
      releaseAlpha = r
    })
    // beta 先就绪建卷成功；alpha 补齐时的 UPDATE 模拟 db locked 失败（被写链吞掉）
    let failUpdates = true
    const updateOk = io.updateGeneration
    io.updateGeneration = async (args) => {
      if (failUpdates) throw new Error("db locked")
      return updateOk(args)
    }

    startGenerationSession({
      words: twoGroupWords,
      config,
      complete: makeComplete({ alphaGate }),
      io,
      runExplanations: expl.run,
    })
    await waitFor(() => calls.create.length === 1, "建卷")
    releaseAlpha()
    await waitFor(() => getNewPaperGeneration()?.running === false, "会话收尾")
    assert.equal(calls.update.length, 0, "UPDATE 被吞：DB 还停在只有 beta 篇的 generating 态")

    // 用户在做题页看到组1 failed，点「重新生成这一篇」。内存里它其实已 done——
    // 必须触发一次重发落库，而不是 targets 为空就无声返回把卷锁死
    failUpdates = false
    const staleQuiz: Quiz = {
      id: 101,
      createdAt: "2026-08-13T00:00:00.000Z",
      config,
      words: [],
      passages: [],
      readingQuestions: [],
      grammarQuestions: [],
      status: "generating",
    }
    regenerateArticles({
      paperId: 101,
      quiz: staleQuiz,
      groupIndexes: [0],
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => calls.update.some((u) => u.status === "ready"), "重发落库拉齐")
    const last = calls.update.at(-1)!
    assert.equal(last.id, 101)
    assert.equal(last.generationJson, null)
    assert.deepEqual(
      parseContent(last.contentJson).passages.map((p) => p.title),
      ["Demo-alphaA", "Demo-betaA"],
    )
  })

  it("取消恰好撞上建卷 IPC 在途：行落库后补删，不给往卷留孤儿卷", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()
    let releaseCreate!: () => void
    const createGate = new Promise<void>((r) => {
      releaseCreate = r
    })
    let createStarted!: () => void
    const createStartedGate = new Promise<void>((r) => {
      createStarted = r
    })
    const createOk = io.createPaper
    io.createPaper = async (args) => {
      createStarted()
      await createGate
      return createOk(args)
    }

    const groupWords = ["gammaA", "gammaB"]
    const complete = (async (callOpts: any) => {
      if (callOpts.schema === generatedPaperStage1Schema)
        return structured(structuredClone(makeReadingPaper(groupWords)))
      if (callOpts.schema === answerCheckSchema)
        return structured({
          readingAnswers: groupWords.map((_, i) => ({ questionIndex: i, answer: "A" })),
          grammarAnswers: [],
        })
      throw new Error("未预期的调用")
    }) as CompleteStructured
    startGenerationSession({
      words: groupWords.map((word) => ({ word, origin: "today" as const })),
      config,
      complete,
      io,
      runExplanations: expl.run,
    })

    // create 已发出（IPC 在途）时用户取消——paperId 还是 null，取消放行
    await createStartedGate
    cancelGenerationSession()
    assert.equal(getNewPaperGeneration(), null)

    releaseCreate()
    await waitFor(() => calls.deleted.length === 1, "孤儿卷补删")
    assert.equal(calls.deleted[0], 101)
    assert.equal(getPaperGeneration(101), undefined, "取消的会话不登记")
    assert.equal(calls.update.length, 0)
    assert.equal(expl.calls.length, 0, "取消后解析不再排队")
  })
})

describe("generation-session · 继续生成 / 单篇重新生成（冷启动）", () => {
  it("从 generation_json 重建会话：点名组重生成，未点名 done 组内容原样保留，落库翻 ready", async () => {
    resetGenerationSessions()
    const { io, calls } = makeIo()
    const expl = makeExplanations()

    // 落库形态的卷：组1（alpha）failed，组2（beta）done —— 模拟重启后内存会话已死
    const betaPassage: Passage = {
      id: "psg-beta",
      title: "Demo-betaA",
      paragraphs: ["p1"],
      targetWords: betaWords,
    }
    const betaQuestions: ReadingQuestion[] = betaWords.map((w, i) => ({
      id: `rq-beta-${i}`,
      type: "reading",
      passageId: "psg-beta",
      targetWord: w,
      stem: `stem-${w}`,
      options: [
        { label: "A", text: "right" },
        { label: "B", text: "wrong" },
      ],
      answer: "A",
      source: { passageId: "psg-beta", paragraph: 1, quote: "p1" },
    }))
    const storedQuiz: Quiz = {
      id: 55,
      createdAt: "2026-08-13T00:00:00.000Z",
      config,
      words: betaWords.map((word) => ({ word, origin: "today" as const })),
      passages: [betaPassage],
      readingQuestions: betaQuestions,
      grammarQuestions: [],
      status: "generating",
      generation: {
        groups: [
          {
            words: alphaWords.map((word) => ({ word, origin: "today" as const })),
            state: "failed",
            errorCode: "AI_STREAM_FAILED",
          },
          {
            words: betaWords.map((word) => ({ word, origin: "today" as const })),
            state: "done",
            passageId: "psg-beta",
          },
        ],
      },
    }

    regenerateArticles({
      paperId: 55,
      quiz: storedQuiz,
      groupIndexes: [0],
      complete: makeComplete(),
      io,
      runExplanations: expl.run,
    })

    await waitFor(() => getPaperGeneration(55)?.running === false, "重生成收尾")
    assert.equal(calls.create.length, 0, "卷已存在，只走 UPDATE")
    const last = calls.update.at(-1)!
    assert.equal(last.id, 55)
    assert.equal(last.status, "ready")
    assert.equal(last.generationJson, null)
    const content = parseContent(last.contentJson)
    assert.deepEqual(content.passages.map((p) => p.title), ["Demo-alphaA", "Demo-betaA"])
    assert.equal(
      content.passages[1].id,
      "psg-beta",
      "未点名的 done 组从卷面原样重建，不重新生成",
    )
    assert.deepEqual(
      JSON.parse(last.wordsJson).map((w: QuizWord) => w.word),
      [...alphaWords, ...betaWords],
    )
    // 只有重生成的 alpha 篇排解析（beta 的解析早在首轮做过/另行补生成）
    await waitFor(() => expl.calls.length === 1, "重生成篇的解析排队")
    assert.equal(expl.calls[0].paperId, 55)
    assert.equal(expl.calls[0].onlyPassageIds?.length, 1)
    assert.notEqual(expl.calls[0].onlyPassageIds?.[0], "psg-beta")
  })
})
