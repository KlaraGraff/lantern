import type {
  GrammarFillQuestion,
  Passage,
  Quiz,
  QuizConfig,
  QuizWord,
  ReadingQuestion,
} from './types.ts'
import { normalizeAnswer } from './judge.ts'
import {
  buildAnswerCheckPrompt,
  buildExplanationPrompt,
  buildGeneratePrompt,
  buildMaskedCheckPrompt,
} from './prompts.ts'
import {
  answerCheckSchema,
  generatedExplanationsSchema,
  generatedPaperStage1Schema,
  maskedCheckVerdictSchema,
  type GeneratedPaperStage1,
} from './schemas.ts'
import { splitWords } from './split.ts'
import {
  completeStructured as defaultCompleteStructured,
  extractJson,
  type ChatMessage,
} from './transport.ts'
import { createUuid } from '../utils/randomUuid.ts'

/**
 * 测试注入点：Tauri 的 `invoke` 在 Node 测试环境里没有 IPC 桥（既不能连后端，
 * 也没有必要在这一层测——契约测试留给 transport.ts 自己）。generate.ts 的
 * 编排逻辑（明答校验 + 遮词自检失败题合并、重出）用测试替身验证，真实调用
 * 场景一律省略这个参数，落回 transport.ts 的 completeStructured。
 */
export type CompleteStructured = typeof defaultCompleteStructured

/**
 * 取消句柄注册表（docs/impls/cijuan-merge.md 步骤 4 · UI 实现）：把 `complete`
 * 包一层——每次真正发起请求前生成一个*全新*的 uuid，登记进调用方传入的
 * `registry`，settle（无论成功失败）后立刻摘除。UI 侧「生成中屏」的取消按钮
 * 据此对 registry 里当时还在场的每个 id 调 transport 的 `cancelRequest`。
 *
 * 每次调用都必须是全新 id，绝不能复用——后端的取消通道是一张
 * pending-cancellation 表，若把已经 settle、已从表里摘掉的旧 id 交给下一次
 * 请求，下一次请求会一发起就被这张陈旧的「待取消」记录误杀。
 *
 * 不传 registry（真实调用场景之外没有取消入口，或调用方尚未接入取消 UI）时
 * 原样返回 `complete`，不生成、不传 requestId——请求仍然可以正常发出，
 * 只是没有取消句柄，交由更底层（transport.ts 的 completeStructured/
 * completeText）按需自行兜底。
 */
function withRequestRegistry(
  complete: CompleteStructured,
  registry?: Set<string>,
): CompleteStructured {
  if (!registry) return complete
  const wrapped: CompleteStructured = async (opts) => {
    const requestId = createUuid()
    registry.add(requestId)
    try {
      return await complete({ ...opts, requestId })
    } finally {
      registry.delete(requestId)
    }
  }
  return wrapped
}

/**
 * 阶段一每组调用的续写凭据：实际发送的最后一条 user 消息全文（含 schema 附块）
 * 与模型的原始回复全文。只保留在内存里（generateQuiz 的返回值），不持久化、
 * 不进 content_json——续写只在「刚生成完」这一次机会里有意义，重启 App 后
 * 再补生成解析就已经超出缓存时效，那条路径退回确定性重建（见 toStage1Paper）。
 */
export interface GenerationTrace {
  passageId: string
  stage1UserMessage: string
  stage1RawResponse: string
}

/**
 * 生成编排。迁自 labs/cijuan/src/llm/generate.ts，按两阶段生成改写
 * （docs/impls/cijuan-merge.md §二.6 —— 本步骤最大的非搬运改动）：
 *
 * - `generateQuiz` 只做阶段一：拆词 → 各组并发出题 → 明答校验 + 遮词自检（并行）→
 *   两者失败题合并重出（一轮止损）→ 返回可作答的卷（无解析字段）。
 * - `generateExplanations` 独立导出，供 UI 层在发卷后台调用：按 passageId 重新分组、
 *   以「续写同一对话」的形态逐组请求解析，失败不抛出、返回缺失的 passageId 清单
 *   （UI 用它渲染「点击补生成」）。这个函数只吃 `Quiz` 本身——不依赖阶段一调用时的
 *   任何内存态——所以「发卷后立刻续写」和「重启 App 后点击补生成」走的是同一段代码：
 *   阶段一的 assistant 回合是从 Quiz 已有数据**确定性地**重新序列化出来的
 *   （见 toStage1Paper），不需要额外持久化一份「生成会话」状态。
 */

/** 生成进度，对应加载页的四步：拆词 → 撰写 → 校验（明答+遮词） → 重出（如有） → 发卷 */
export type GenerateStep = 'splitting' | 'writing' | 'checking' | 'regenerating' | 'done'

export type ProgressFn = (step: GenerateStep) => void

let idCounter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idCounter}`

/**
 * 阶段一：拆词 → 每组词一次调用（一篇文章+它的题）并发生成 → 明答校验 + 遮词自检
 * （并行）→ 合并失败题重出一轮。按组分次调用而不是整卷一次：词多时单次输出会顶到
 * max_tokens 被截断，且分次可并发。
 */
export async function generateQuiz(opts: {
  words: QuizWord[]
  config: QuizConfig
  onProgress?: ProgressFn
  /** 测试注入点，见上方 CompleteStructured 说明；省略时用真实 transport */
  complete?: CompleteStructured
  /** 取消句柄注册表，见上方 withRequestRegistry 说明；不传则不生成取消句柄 */
  requestRegistry?: Set<string>
}): Promise<{ quiz: Quiz; traces: GenerationTrace[] }> {
  const { words, config } = opts
  const progress = opts.onProgress ?? (() => {})
  const complete = withRequestRegistry(opts.complete ?? defaultCompleteStructured, opts.requestRegistry)

  progress('splitting')
  const groups = splitWords(words)

  progress('writing')
  const results = await Promise.all(
    groups.map((group) =>
      complete({
        messages: [
          {
            role: 'user',
            content: buildGeneratePrompt({
              words: group.map((w) => w.word),
              difficulty: config.difficulty,
              types: config.types,
            }),
          },
        ],
        schema: generatedPaperStage1Schema,
        maxTokens: 16000,
        // 让明答校验（阶段一收卷前的质检）续写这次对话时能命中前缀缓存
        cache: true,
      }),
    ),
  )

  const passages: Passage[] = []
  let readingQuestions: ReadingQuestion[] = []
  let grammarQuestions: GrammarFillQuestion[] = []
  const traces: GenerationTrace[] = []

  for (const result of results) {
    const paper = result.data
    // 每次调用只该有一篇文章；模型多给的丢弃，题目全部挂到本组文章上
    const p = paper.passages[0]
    if (!p) continue
    const passage: Passage = {
      id: nextId('psg'),
      title: p.title,
      paragraphs: p.paragraphs,
      targetWords: p.targetWords,
    }
    passages.push(passage)
    traces.push({
      passageId: passage.id,
      stage1UserMessage: result.requestMessage,
      stage1RawResponse: result.rawResponse,
    })
    for (const q of paper.readingQuestions) {
      readingQuestions.push({
        id: nextId('rq'),
        type: 'reading',
        passageId: passage.id,
        targetWord: q.targetWord,
        stem: q.stem,
        options: q.options.map((o) => ({ label: o.label, text: o.text })),
        answer: q.answer,
        source: { passageId: passage.id, paragraph: q.sourceParagraph, quote: q.sourceQuote },
      })
    }
    for (const q of paper.grammarQuestions) {
      grammarQuestions.push({
        id: nextId('gq'),
        type: 'grammarFill',
        passageId: passage.id,
        targetWord: q.targetWord,
        sentence: q.sentence,
        hint: q.hint,
        answer: q.answer,
      })
    }
  }

  // 覆盖校验：没被任何题考到的词从本卷词表剔除——否则池中的重现词会被
  // 误当作「已重现但没答错」，永远滞留在到期队列里，每张新卷都白白多背一次成本
  const covered = new Set(
    [...readingQuestions, ...grammarQuestions].map((q) => q.targetWord.toLowerCase()),
  )
  const coveredWords = words.filter((w) => covered.has(w.word.toLowerCase()))

  if (readingQuestions.length > 0 || grammarQuestions.length > 0) {
    progress('checking')
    const [answerCheck, maskedFailedIdx] = await Promise.all([
      runAnswerCheck({ readingQuestions, grammarQuestions, traces, complete }),
      config.maskedCheck && readingQuestions.length > 0
        ? runMaskedCheck({ passages, readingQuestions, complete })
        : Promise.resolve(new Set<number>()),
    ])
    const readingFailedIdx = new Set([...answerCheck.readingFailed, ...maskedFailedIdx])
    const grammarFailedIdx = answerCheck.grammarFailed

    if (readingFailedIdx.size > 0 || grammarFailedIdx.size > 0) {
      progress('regenerating')
      const redone = await redoFailedQuestions({
        passages,
        readingQuestions,
        grammarQuestions,
        readingFailedIdx,
        grammarFailedIdx,
        config,
        complete,
      })
      readingQuestions = redone.readingQuestions
      grammarQuestions = redone.grammarQuestions
    }
  }

  progress('done')
  return {
    quiz: {
      createdAt: new Date().toISOString(),
      config,
      words: coveredWords,
      passages,
      readingQuestions,
      grammarQuestions,
      status: 'ready',
    },
    traces,
  }
}

/**
 * 明答校验（新增质检，docs/impls/cijuan-merge.md §二.6）：按 passageId 分组，
 * 续写各组阶段一的原始对话——user 轮回放 trace.stage1UserMessage 逐字节原文
 * （命中 prompt cache），assistant 轮回放 trace.stage1RawResponse 的「去答案版」
 * （见下方 stripStage1Answers，问题 1 修复：不能让模型看见自己两轮前写的答案，
 * 否则「重做一遍」名存实亡）——追加一条「重做一遍」指令，不遮词、不告知既定答案，
 * 与答案键不一致的题记为失败。
 *
 * 每组独立请求、独立失败：某一组调用/解析异常只降级为「这组本轮不参与该质检」
 * （console.warn 后跳过），不拖累其它组，也不让整卷因质检门故障而报废——质检门
 * 失效的正确后果是退回原版「无质检」的行为，不是把一张已经花钱生成好的卷子
 * 直接丢弃。
 */
/**
 * 明答校验续写用的「去答案版」assistant 回合：从阶段一原始回复里删掉每道题的
 * answer 字段，再重新序列化。不这样做的话，续写对话里模型会看到自己两轮前
 * 写下的 "answer":"B"，「独立重解」名存实亡，必然照抄，质检门形同虚设。
 *
 * 只字面删除 answer 键，不做任何其它改写——user 轮（trace.stage1UserMessage）
 * 不动，缓存前缀只覆盖到那条 user 消息，这里的 assistant 轮本就不在缓存前缀里，
 * 可以自由改写，不影响 prompt cache 命中率。
 *
 * 解析失败在理论上不可能发生（这段文本就是阶段一自己的回复，已经过 zod 校验
 * 才能进到这里）；万一发生，直接抛出，交给调用方 runAnswerCheck 已有的
 * try/catch 降级路径处理（console.warn 后这一组本轮跳过质检，不阻塞整卷）。
 */
function stripStage1Answers(rawResponse: string): string {
  const parsed = JSON.parse(extractJson(rawResponse))
  const omitAnswer = (q: Record<string, unknown>) => {
    const rest = { ...q }
    delete rest.answer
    return rest
  }
  return JSON.stringify({
    ...parsed,
    readingQuestions: (parsed.readingQuestions ?? []).map(omitAnswer),
    grammarQuestions: (parsed.grammarQuestions ?? []).map(omitAnswer),
  })
}

async function runAnswerCheck(opts: {
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  traces: GenerationTrace[]
  complete: CompleteStructured
}): Promise<{ readingFailed: Set<number>; grammarFailed: Set<number> }> {
  const { readingQuestions, grammarQuestions, traces, complete } = opts
  // 组内 questionIndex 是「这一组过滤后的子数组」下标，不是整卷全局下标——
  // 用 id 把每道题映射回它在全局 readingQuestions/grammarQuestions 里的下标
  const readingGlobalIndex = new Map(readingQuestions.map((q, i) => [q.id, i]))
  const grammarGlobalIndex = new Map(grammarQuestions.map((q, i) => [q.id, i]))
  const readingFailed = new Set<number>()
  const grammarFailed = new Set<number>()

  await Promise.all(
    traces.map(async (trace) => {
      const groupReading = readingQuestions.filter((q) => q.passageId === trace.passageId)
      const groupGrammar = grammarQuestions.filter((q) => q.passageId === trace.passageId)
      if (groupReading.length === 0 && groupGrammar.length === 0) return

      try {
        const strippedAssistant = stripStage1Answers(trace.stage1RawResponse)
        const { data: check } = await complete({
          messages: [
            { role: 'user', content: trace.stage1UserMessage },
            { role: 'assistant', content: strippedAssistant },
            {
              role: 'user',
              content: buildAnswerCheckPrompt({
                readingQuestions: groupReading,
                grammarQuestions: groupGrammar,
              }),
            },
          ],
          schema: answerCheckSchema,
          maxTokens: 8000,
          cache: true,
        })

        for (const v of check.readingAnswers) {
          const q = groupReading[v.questionIndex]
          if (!q || q.answer === v.answer) continue
          const globalIdx = readingGlobalIndex.get(q.id)
          if (globalIdx !== undefined) readingFailed.add(globalIdx)
        }
        for (const v of check.grammarAnswers) {
          const q = groupGrammar[v.questionIndex]
          if (!q || normalizeAnswer(q.answer) === normalizeAnswer(v.answer)) continue
          const globalIdx = grammarGlobalIndex.get(q.id)
          if (globalIdx !== undefined) grammarFailed.add(globalIdx)
        }
      } catch (err) {
        console.warn('明答校验调用失败（该组跳过），本轮该组不参与这项质检', err)
      }
    }),
  )

  return { readingFailed, grammarFailed }
}

/**
 * 遮词自检：遮住目标词让模型重做。模型仍能有把握答对（confident 且答案一致）的题
 * = 没考到词 → 记为失败，交给顶层与明答校验的失败集合合并后统一重出。
 * 调用失败同样降级为空失败集（见 runAnswerCheck 顶部注释，两个质检门待遇一致）。
 */
async function runMaskedCheck(opts: {
  passages: Passage[]
  readingQuestions: ReadingQuestion[]
  complete: CompleteStructured
}): Promise<Set<number>> {
  const { passages, readingQuestions, complete } = opts
  try {
    const byId = new Map(passages.map((p) => [p.id, p]))
    const items = readingQuestions.map((q) => ({ passage: byId.get(q.passageId)!, question: q }))

    const { data: check } = await complete({
      messages: [{ role: 'user', content: buildMaskedCheckPrompt(items) }],
      schema: maskedCheckVerdictSchema,
      maxTokens: 8000,
    })

    return new Set(
      check.verdicts
        .filter((v) => v.confident && readingQuestions[v.questionIndex]?.answer === v.answeredWithoutWord)
        .map((v) => v.questionIndex),
    )
  } catch (err) {
    console.warn('遮词自检调用失败，本轮跳过该质检门', err)
    return new Set<number>()
  }
}

/**
 * 重出一轮（明答校验 + 遮词自检失败题的合并结果，止损原则不变：只重出一轮，
 * 重出失败则保留原题，宁可这道题考点弱一点也不阻塞整卷）。
 */
async function redoFailedQuestions(opts: {
  passages: Passage[]
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  readingFailedIdx: Set<number>
  grammarFailedIdx: Set<number>
  config: QuizConfig
  complete: CompleteStructured
}): Promise<{ readingQuestions: ReadingQuestion[]; grammarQuestions: GrammarFillQuestion[] }> {
  const {
    passages,
    readingQuestions,
    grammarQuestions,
    readingFailedIdx,
    grammarFailedIdx,
    config,
    complete,
  } = opts
  const readingOrder = [...readingFailedIdx].sort((a, b) => a - b)
  const grammarOrder = [...grammarFailedIdx].sort((a, b) => a - b)

  try {
    const { data: redo } = await complete({
      messages: [
        {
          role: 'user',
          content: buildGeneratePrompt({
            words: [],
            difficulty: config.difficulty,
            types: config.types,
            regenerate: {
              passages,
              failedReadingQuestions: readingOrder.map((i) => readingQuestions[i]),
              failedGrammarQuestions: grammarOrder.map((i) => grammarQuestions[i]),
            },
          }),
        },
      ],
      schema: generatedPaperStage1Schema,
      maxTokens: 16000,
    })

    // 消费式映射：按 targetWord（小写）分桶，而不是按位置对位——重出提示里阅读、
    // 语法两个列表各自从 1 重新编号，模型换序时位置对位会把 A 词的题面配上 B 词的
    // 答案，错词池会记错词。找不到同词条目就保留原题（一轮止损原则不变）。
    const byId = new Map(passages.map((p) => [p.id, p]))

    const redoReadingByWord = new Map<string, GeneratedPaperStage1['readingQuestions']>()
    for (const r of redo.readingQuestions) {
      const key = r.targetWord.toLowerCase()
      const bucket = redoReadingByWord.get(key)
      if (bucket) bucket.push(r)
      else redoReadingByWord.set(key, [r])
    }
    const redoGrammarByWord = new Map<string, GeneratedPaperStage1['grammarQuestions']>()
    for (const r of redo.grammarQuestions) {
      const key = r.targetWord.toLowerCase()
      const bucket = redoGrammarByWord.get(key)
      if (bucket) bucket.push(r)
      else redoGrammarByWord.set(key, [r])
    }

    const nextReading = readingQuestions.map((q, i) => {
      if (!readingFailedIdx.has(i)) return q
      const bucket = redoReadingByWord.get(q.targetWord.toLowerCase())
      const r = bucket?.shift()
      if (!r) return q
      // 重出必然是同一篇文章——忽略模型回的 passageIndex（阶段一提示词教过
      // 「重出时 passageIndex 一律填 0」，多篇卷场景下这个值会指错文章）
      const passage = byId.get(q.passageId)
      if (!passage) return q
      return {
        ...q,
        stem: r.stem,
        options: r.options.map((o) => ({ label: o.label, text: o.text })),
        answer: r.answer,
        source: { passageId: passage.id, paragraph: r.sourceParagraph, quote: r.sourceQuote },
      }
    })
    const nextGrammar = grammarQuestions.map((q, i) => {
      if (!grammarFailedIdx.has(i)) return q
      const bucket = redoGrammarByWord.get(q.targetWord.toLowerCase())
      const r = bucket?.shift()
      if (!r) return q
      return { ...q, sentence: r.sentence, hint: r.hint, answer: r.answer }
    })
    return { readingQuestions: nextReading, grammarQuestions: nextGrammar }
  } catch {
    // 重出失败不阻塞整卷：保留原题，宁可这道题考点弱一点
    return { readingQuestions, grammarQuestions }
  }
}

// ===== 阶段二：解析生成（独立导出，UI 在发卷后台调用） =====

export interface ExplanationGroup {
  passage: Passage
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
}

/**
 * 按 passageId 把整卷重新分组——阅读题天然带 passageId，语法题的 passageId
 * 记录了它与哪篇文章的阅读题同属一次阶段一调用（见 types.ts 的字段注释）。
 * 纯函数，不发请求，`generateExplanations` 与测试都用它。
 */
export function regroupForExplanations(quiz: Quiz): ExplanationGroup[] {
  return quiz.passages.map((passage) => ({
    passage,
    readingQuestions: quiz.readingQuestions.filter((q) => q.passageId === passage.id),
    grammarQuestions: quiz.grammarQuestions.filter((q) => q.passageId === passage.id),
  }))
}

/** 把一组阅读/语法题还原成阶段一 API 形状，作为续写对话里的 assistant 回合 */
function toStage1Paper(
  passage: Passage,
  readingQuestions: ReadingQuestion[],
  grammarQuestions: GrammarFillQuestion[],
): GeneratedPaperStage1 {
  return {
    passages: [
      { title: passage.title, paragraphs: passage.paragraphs, targetWords: passage.targetWords },
    ],
    readingQuestions: readingQuestions.map((q) => ({
      passageIndex: 0,
      targetWord: q.targetWord,
      stem: q.stem,
      options: q.options.map((o) => ({ label: o.label, text: o.text })),
      answer: q.answer,
      sourceParagraph: q.source.paragraph,
      sourceQuote: q.source.quote,
    })),
    grammarQuestions: grammarQuestions.map((q) => ({
      targetWord: q.targetWord,
      sentence: q.sentence,
      hint: q.hint,
      answer: q.answer,
    })),
  }
}

export interface GenerateExplanationsResult {
  quiz: Quiz
  /** 解析生成失败的组，按 passageId 报告；UI 据此渲染「点击补生成」 */
  missingPassageIds: string[]
}

/**
 * 阶段二：逐组以「续写同一对话」的形态请求解析。每组独立失败、独立重试，
 * 一组失败不影响其它组，也不抛出——调用方（UI）用 missingPassageIds 决定
 * 哪些题显示「解析补生成中」骨架屏。
 */
export async function generateExplanations(opts: {
  quiz: Quiz
  onProgress?: (passageId: string) => void
  /**
   * 阶段一保留的内存态续写凭据（generateQuiz 的返回值之一）。有则原样回放
   * 阶段一该组的 user/assistant 原文续写，命中 prompt cache；不传（冷启动
   * 补生成兜底，比如重启 App 后点「补生成」）则退回下方用 Quiz 数据确定性
   * 重建的旧路径——本来就已超出缓存时效，蹭不到缓存，行为不变。
   */
  traces?: GenerationTrace[]
  /** 测试注入点，见 CompleteStructured 说明；省略时用真实 transport */
  complete?: CompleteStructured
}): Promise<GenerateExplanationsResult> {
  const { quiz } = opts
  const onProgress = opts.onProgress ?? (() => {})
  const complete = opts.complete ?? defaultCompleteStructured
  const groups = regroupForExplanations(quiz)
  const tracesByPassageId = new Map((opts.traces ?? []).map((t) => [t.passageId, t]))

  const updatedReading = new Map(quiz.readingQuestions.map((q) => [q.id, q]))
  const updatedGrammar = new Map(quiz.grammarQuestions.map((q) => [q.id, q]))
  const missingPassageIds: string[] = []

  await Promise.all(
    groups.map(async (group) => {
      if (group.readingQuestions.length === 0 && group.grammarQuestions.length === 0) return

      try {
        const explanationPrompt = buildExplanationPrompt({
          readingQuestions: group.readingQuestions,
          grammarQuestions: group.grammarQuestions,
        })
        const trace = tracesByPassageId.get(group.passage.id)

        const messages: ChatMessage[] = trace
          ? [
              { role: 'user', content: trace.stage1UserMessage },
              { role: 'assistant', content: trace.stage1RawResponse },
              { role: 'user', content: explanationPrompt },
            ]
          : [
              {
                role: 'user',
                content: buildGeneratePrompt({
                  words: [
                    ...group.passage.targetWords,
                    ...group.grammarQuestions.map((q) => q.targetWord),
                  ],
                  difficulty: quiz.config.difficulty,
                  types: quiz.config.types,
                }),
              },
              {
                role: 'assistant',
                content: JSON.stringify(
                  toStage1Paper(group.passage, group.readingQuestions, group.grammarQuestions),
                ),
              },
              { role: 'user', content: explanationPrompt },
            ]

        const { data: result } = await complete({
          messages,
          schema: generatedExplanationsSchema,
          maxTokens: 16000,
          cache: true,
        })

        for (const exp of result.readingExplanations) {
          const q = group.readingQuestions[exp.questionIndex]
          if (!q) continue
          updatedReading.set(q.id, {
            ...q,
            stemTranslation: exp.stemTranslation,
            howToSolve: exp.howToSolve,
            wordNote: exp.wordNote,
            options: q.options.map((o) => {
              const match = exp.options.find((eo) => eo.label === o.label)
              return match ? { ...o, meaning: match.meaning, note: match.note } : o
            }),
            // schema 用 .nullish() 兼容模型给 null 表示「没有异议」；这里统一收口成
            // undefined —— 领域类型（types.ts）只声明 string | undefined，没有 null
            answerDispute: exp.answerDispute ?? undefined,
          })
        }
        for (const exp of result.grammarExplanations) {
          const q = group.grammarQuestions[exp.questionIndex]
          if (!q) continue
          updatedGrammar.set(q.id, {
            ...q,
            sentenceTranslation: exp.sentenceTranslation,
            grammarPoints: exp.grammarPoints,
            reasoning: exp.reasoning,
            wrongForms: exp.wrongForms,
            wordMeaning: exp.wordMeaning,
            answerDispute: exp.answerDispute ?? undefined,
          })
        }
        onProgress(group.passage.id)
      } catch {
        // 这一组解析生成失败：不抛出、不影响其它组，留给 UI「点击补生成」兜底
        missingPassageIds.push(group.passage.id)
      }
    }),
  )

  return {
    quiz: {
      ...quiz,
      readingQuestions: quiz.readingQuestions.map((q) => updatedReading.get(q.id) ?? q),
      grammarQuestions: quiz.grammarQuestions.map((q) => updatedGrammar.get(q.id) ?? q),
    },
    missingPassageIds,
  }
}
