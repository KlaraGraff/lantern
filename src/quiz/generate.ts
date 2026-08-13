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
import { getAiErrorCode, type AiErrorCode } from '../utils/aiError.ts'

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
 * - `generateQuiz` 只做阶段一：拆词 → **每篇文章一条独立流水线**（写稿 →
 *   明答校验 + 遮词自检并行 → 失败题合并重出一轮）→ 汇总发卷（无解析字段）。
 *   流水线之间互不等待：一篇写完立刻进它自己的校验，不设阶段屏障——总耗时
 *   等于最慢的一条流水线，而不是「每阶段最慢者」之和。在飞请求数：写稿期
 *   等于篇数，校验期每篇最多 2 路（明答 + 遮词并行），与旧版校验阶段的
 *   「篇数 + 1 路」同量级。
 * - `generateExplanations` 独立导出，供 UI 层在发卷后台调用：按 passageId 重新分组、
 *   以「续写同一对话」的形态逐组请求解析，失败不抛出、返回缺失的 passageId 清单
 *   （UI 用它渲染「点击补生成」）。这个函数只吃 `Quiz` 本身——不依赖阶段一调用时的
 *   任何内存态——所以「发卷后立刻续写」和「重启 App 后点击补生成」走的是同一段代码：
 *   阶段一的 assistant 回合是从 Quiz 已有数据**确定性地**重新序列化出来的
 *   （见 toStage1Paper），不需要额外持久化一份「生成会话」状态。
 */

/**
 * 一篇文章的流水线阶段：写稿 → 校验（明答+遮词） → 重出（如有） → 完成。
 * `failed` 是终态之一（写稿异常或模型没给出文章）——渐进发卷下失败按篇隔离
 * （docs/impls/quiz-progressive-delivery.md §一.5），生成中屏与做题页占位共用这个状态。
 */
export type ArticleStep = 'writing' | 'checking' | 'regenerating' | 'done' | 'failed'

/**
 * 生成进度（按篇流水线改版）：全卷不再有统一的「当前阶段」——同一时刻第 1 篇
 * 可能在校验、第 2 篇还在写稿——进度以事件流上报，UI 侧聚合成按篇状态。
 * `split` 事件把篇数与各篇词数一次性交给 UI，此后 `article` 事件的 index
 * 都落在这个数组范围内。
 */
export type GenerateProgress =
  | { type: 'splitting' }
  | { type: 'split'; articles: { wordCount: number }[] }
  | { type: 'article'; index: number; step: ArticleStep }
  | { type: 'done' }

export type ProgressFn = (progress: GenerateProgress) => void

let idCounter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idCounter}`

/**
 * 阶段一：拆词 → 每组词一条独立流水线（一篇文章+它的题）→ 汇总。按组分次调用
 * 而不是整卷一次：词多时单次输出会顶到 max_tokens 被截断，且分次可并发。
 * 流水线内部（写稿 → 校验 → 重出）见 runArticlePipeline。
 */
export async function generateQuiz(opts: {
  words: QuizWord[]
  config: QuizConfig
  onProgress?: ProgressFn
  /** 测试注入点，见上方 CompleteStructured 说明；省略时用真实 transport */
  complete?: CompleteStructured
  /** 取消句柄注册表，见上方 withRequestRegistry 说明；不传则不生成取消句柄 */
  requestRegistry?: Set<string>
  /** 出题模型硬指定（设置项 quiz_ai_profile_id），见 transport.ts profileId 说明；不传 = 跟随自动路由 */
  profileId?: string
  /**
   * 每条流水线 settle（成或败）即回调一次——渐进发卷的编排层
   * （generation-session）靠它逐篇落库，不等整卷。回调抛出会连坐整卷 reject，
   * 调用方自己兜好异常。
   */
  onArticle?: (outcome: ArticleOutcome) => void
}): Promise<{ quiz: Quiz; traces: GenerationTrace[]; articles: ArticleOutcome[] }> {
  const { words, config, profileId, onArticle } = opts
  const progress = opts.onProgress ?? (() => {})
  const complete = withRequestRegistry(opts.complete ?? defaultCompleteStructured, opts.requestRegistry)

  progress({ type: 'splitting' })
  const groups = splitWords(words)
  progress({ type: 'split', articles: groups.map((g) => ({ wordCount: g.length })) })

  // 失败按篇隔离（渐进发卷语义，docs/impls/quiz-progressive-delivery.md §一.5）：
  // 某篇写稿失败只让该篇产出 ok:false 的 outcome，其余篇照常走完各自的
  // 校验/重出——每一篇现在都独立有价值（失败篇可单篇重生成），旧版「一篇
  // 失败整卷作废 + 共享 abort 闸」的存在理由已消失。runArticlePipeline 不再
  // 抛出，Promise.all 必然 resolve 且保序。
  const results = await Promise.all(
    groups.map((group, index) =>
      runArticlePipeline({
        group,
        index,
        config,
        complete,
        profileId,
        onStep: (step) => progress({ type: 'article', index, step }),
      }).then((outcome) => {
        onArticle?.(outcome)
        return outcome
      }),
    ),
  )

  // 全部篇都失败时仍 reject：没有任何一篇可发，退回旧的「生成失败屏」路径。
  // 抛第一个拿得到的底层错误，错误码识别（getAiErrorCode）与旧行为一致。
  if (results.every((r) => !r.ok)) {
    throw results.find((r) => r.error != null)?.error ?? new Error('QUIZ_ALL_ARTICLES_FAILED')
  }

  // 汇总：Promise.all 保序，passages 与题目仍按拆词分组的顺序拼接；
  // 失败篇（ok:false）不进卷面，它们的词也不进覆盖结算（见下）
  const passages: Passage[] = []
  const readingQuestions: ReadingQuestion[] = []
  const grammarQuestions: GrammarFillQuestion[] = []
  const traces: GenerationTrace[] = []
  for (const r of results) {
    if (!r.ok || !r.passage || !r.trace) continue
    passages.push(r.passage)
    traces.push(r.trace)
    readingQuestions.push(...r.readingQuestions)
    grammarQuestions.push(...r.grammarQuestions)
  }

  // 覆盖校验：没被任何题考到的词从本卷词表剔除——否则池中的重现词会被
  // 误当作「已重现但没答错」，永远滞留在到期队列里，每张新卷都白白多背一次成本
  const covered = new Set(
    [...readingQuestions, ...grammarQuestions].map((q) => q.targetWord.toLowerCase()),
  )
  const coveredWords = words.filter((w) => covered.has(w.word.toLowerCase()))

  progress({ type: 'done' })
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
    articles: results,
  }
}

/**
 * 一条流水线的产出（渐进发卷的按篇结算单元）。`ok:false` 表示写稿异常或模型
 * 没给出文章——此时 passage/trace 为 null、题目为空，errorCode 是从底层错误
 * 识别出的 AI 错误码（识别不出为 null），error 保留原始异常供整卷全败时上抛。
 * `words` 是该组的拆词结果：失败篇重生成、按篇覆盖结算都要用它。
 */
export interface ArticleOutcome {
  /** 篇号 = 拆词分组下标，与 GenerateProgress 的 article.index 同一坐标系 */
  index: number
  words: QuizWord[]
  ok: boolean
  errorCode: AiErrorCode | null
  error: unknown
  passage: Passage | null
  trace: GenerationTrace | null
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
}

/**
 * 一篇文章的完整流水线：写稿 → 明答校验 + 遮词自检（并行）→ 失败题合并重出
 * （一轮止损）。各篇互不等待，一篇写完立刻进它自己的校验。
 *
 * 缓存硬约束（DeepSeek 前缀缓存，命中约一折计价）：明答校验与阶段二解析靠把
 * 「写稿请求 + 模型原始回答」逐字节原样放在消息开头命中缓存。因此写稿提示词
 * 里不许出现任何会变的内容（时间戳/随机数/序号）——它只由词表与配置决定；
 * 题目 id（nextId 带时间戳）只存在于领域对象里，从不进提示词。
 */
async function runArticlePipeline(opts: {
  group: QuizWord[]
  /** 篇号（拆词分组下标），原样进 ArticleOutcome.index */
  index: number
  config: QuizConfig
  complete: CompleteStructured
  profileId?: string
  onStep: (step: ArticleStep) => void
}): Promise<ArticleOutcome> {
  const { group, index, config, complete, profileId, onStep } = opts

  // 写稿失败（调用异常/模型没给文章）→ 失败终态，不抛出：失败按篇隔离，
  // 其余流水线照常走完（见 generateQuiz 顶部注释）
  const failed = (error: unknown): ArticleOutcome => {
    onStep('failed')
    return {
      index,
      words: group,
      ok: false,
      errorCode: getAiErrorCode(error),
      error,
      passage: null,
      trace: null,
      readingQuestions: [],
      grammarQuestions: [],
    }
  }

  onStep('writing')
  let result
  try {
    result = await complete({
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
      // 让明答校验（本篇收卷前的质检）续写这次对话时能命中前缀缓存
      cache: true,
      profileId,
    })
  } catch (err) {
    return failed(err)
  }

  const paper = result.data
  // 每次调用只该有一篇文章；模型多给的丢弃，题目全部挂到本组文章上
  const p = paper.passages[0]
  if (!p) {
    return failed(new Error('模型没有产出文章（passages 为空）'))
  }
  const passage: Passage = {
    id: nextId('psg'),
    title: p.title,
    paragraphs: p.paragraphs,
    targetWords: p.targetWords,
  }
  const trace: GenerationTrace = {
    passageId: passage.id,
    stage1UserMessage: result.requestMessage,
    stage1RawResponse: result.rawResponse,
  }
  let readingQuestions: ReadingQuestion[] = paper.readingQuestions.map((q) => ({
    id: nextId('rq'),
    type: 'reading',
    passageId: passage.id,
    targetWord: q.targetWord,
    stem: q.stem,
    options: q.options.map((o) => ({ label: o.label, text: o.text })),
    answer: q.answer,
    source: { passageId: passage.id, paragraph: q.sourceParagraph, quote: q.sourceQuote },
  }))
  let grammarQuestions: GrammarFillQuestion[] = paper.grammarQuestions.map((q) => ({
    id: nextId('gq'),
    type: 'grammarFill',
    passageId: passage.id,
    targetWord: q.targetWord,
    sentence: q.sentence,
    hint: q.hint,
    answer: q.answer,
  }))

  if (readingQuestions.length > 0 || grammarQuestions.length > 0) {
    onStep('checking')
    const [answerCheck, maskedFailedIdx] = await Promise.all([
      runAnswerCheck({ readingQuestions, grammarQuestions, trace, complete, profileId }),
      config.maskedCheck && readingQuestions.length > 0
        ? runMaskedCheck({ passage, readingQuestions, complete, profileId })
        : Promise.resolve(new Set<number>()),
    ])
    const readingFailedIdx = new Set([...answerCheck.readingFailed, ...maskedFailedIdx])
    const grammarFailedIdx = answerCheck.grammarFailed

    if (readingFailedIdx.size > 0 || grammarFailedIdx.size > 0) {
      onStep('regenerating')
      const redone = await redoFailedQuestions({
        passage,
        readingQuestions,
        grammarQuestions,
        readingFailedIdx,
        grammarFailedIdx,
        config,
        complete,
        profileId,
      })
      readingQuestions = redone.readingQuestions
      grammarQuestions = redone.grammarQuestions
    }
  }

  onStep('done')
  return {
    index,
    words: group,
    ok: true,
    errorCode: null,
    error: null,
    passage,
    trace,
    readingQuestions,
    grammarQuestions,
  }
}

/**
 * 单篇流水线的独立入口：「继续生成 / 单篇重新生成」用它对一个词组重跑
 * 写稿 → 校验 → 重出，与 generateQuiz 内部走的是同一段代码
 * （runArticlePipeline），失败同样不抛出、产出 ok:false 的 outcome。
 * `index` 传原篇位（generation_json 的组下标），让进度事件与落库都能对上号。
 */
export async function generateArticle(opts: {
  words: QuizWord[]
  config: QuizConfig
  /** 原篇位（组序）；省略时按单篇卷处理，记 0 */
  index?: number
  onStep?: (step: ArticleStep) => void
  /** 测试注入点，见 CompleteStructured 说明；省略时用真实 transport */
  complete?: CompleteStructured
  /** 取消句柄注册表，见 withRequestRegistry 说明；不传则不生成取消句柄 */
  requestRegistry?: Set<string>
  /** 出题模型硬指定（设置项 quiz_ai_profile_id）；不传 = 跟随自动路由 */
  profileId?: string
}): Promise<ArticleOutcome> {
  const complete = withRequestRegistry(opts.complete ?? defaultCompleteStructured, opts.requestRegistry)
  return runArticlePipeline({
    group: opts.words,
    index: opts.index ?? 0,
    config: opts.config,
    complete,
    profileId: opts.profileId,
    onStep: opts.onStep ?? (() => {}),
  })
}

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
 * try/catch 降级路径处理（console.warn 后本篇本轮跳过质检，不阻塞流水线）。
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

/**
 * 明答校验（按篇质检，docs/impls/cijuan-merge.md §二.6）：续写本篇阶段一的原始
 * 对话——user 轮回放 trace.stage1UserMessage 逐字节原文（命中 prompt cache），
 * assistant 轮回放 trace.stage1RawResponse 的「去答案版」（见上方
 * stripStage1Answers：不能让模型看见自己两轮前写的答案，否则「重做一遍」
 * 名存实亡）——追加一条「重做一遍」指令，不遮词、不告知既定答案，与答案键
 * 不一致的题记为失败。返回的下标就是本篇题目数组的下标，直接与遮词自检合并。
 *
 * 调用/解析异常降级为空失败集（console.warn 后跳过），不让本篇因质检门故障
 * 而报废——质检门失效的正确后果是退回原版「无质检」的行为，不是把一篇已经
 * 花钱生成好的文章和题目直接丢弃。
 */
async function runAnswerCheck(opts: {
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  trace: GenerationTrace
  complete: CompleteStructured
  profileId?: string
}): Promise<{ readingFailed: Set<number>; grammarFailed: Set<number> }> {
  const { readingQuestions, grammarQuestions, trace, complete, profileId } = opts
  const readingFailed = new Set<number>()
  const grammarFailed = new Set<number>()

  try {
    const strippedAssistant = stripStage1Answers(trace.stage1RawResponse)
    const { data: check } = await complete({
      messages: [
        { role: 'user', content: trace.stage1UserMessage },
        { role: 'assistant', content: strippedAssistant },
        {
          role: 'user',
          content: buildAnswerCheckPrompt({ readingQuestions, grammarQuestions }),
        },
      ],
      schema: answerCheckSchema,
      maxTokens: 8000,
      cache: true,
      profileId,
    })

    for (const v of check.readingAnswers) {
      const q = readingQuestions[v.questionIndex]
      if (q && q.answer !== v.answer) readingFailed.add(v.questionIndex)
    }
    for (const v of check.grammarAnswers) {
      const q = grammarQuestions[v.questionIndex]
      if (q && normalizeAnswer(q.answer) !== normalizeAnswer(v.answer)) {
        grammarFailed.add(v.questionIndex)
      }
    }
  } catch (err) {
    console.warn('明答校验调用失败，本篇本轮不参与这项质检', err)
  }

  return { readingFailed, grammarFailed }
}

/**
 * 遮词自检（按篇质检）：遮住目标词让模型重做本篇的阅读题。模型仍能有把握答对
 * （confident 且答案一致）的题 = 没考到词 → 记为失败，交给流水线与明答校验的
 * 失败集合合并后统一重出。原版是整卷一次调用；按篇拆开后提示词只含本篇的
 * 文章与题目——这个调用本就不带 cache（遮改后的文本与阶段一前缀不同），
 * 与缓存前缀无关，拆小只是让它跟着本篇流水线走、不等别篇。
 * 调用失败同样降级为空失败集（见 runAnswerCheck 顶部注释，两个质检门待遇一致）。
 */
async function runMaskedCheck(opts: {
  passage: Passage
  readingQuestions: ReadingQuestion[]
  complete: CompleteStructured
  profileId?: string
}): Promise<Set<number>> {
  const { passage, readingQuestions, complete, profileId } = opts
  try {
    const items = readingQuestions.map((question) => ({ passage, question }))

    const { data: check } = await complete({
      messages: [{ role: 'user', content: buildMaskedCheckPrompt(items) }],
      schema: maskedCheckVerdictSchema,
      maxTokens: 8000,
      profileId,
    })

    return new Set(
      check.verdicts
        .filter((v) => v.confident && readingQuestions[v.questionIndex]?.answer === v.answeredWithoutWord)
        .map((v) => v.questionIndex),
    )
  } catch (err) {
    console.warn('遮词自检调用失败，本篇本轮跳过该质检门', err)
    return new Set<number>()
  }
}

/**
 * 重出一轮（本篇明答校验 + 遮词自检失败题的合并结果，止损原则不变：只重出一轮，
 * 重出失败则保留原题，宁可这道题考点弱一点也不阻塞本篇流水线）。
 * 按篇拆开后重出提示词只带本篇文章；这个调用不带 cache（重出是全新对话，
 * 前缀与阶段一不同），与缓存前缀无关。
 */
async function redoFailedQuestions(opts: {
  passage: Passage
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  readingFailedIdx: Set<number>
  grammarFailedIdx: Set<number>
  config: QuizConfig
  complete: CompleteStructured
  profileId?: string
}): Promise<{ readingQuestions: ReadingQuestion[]; grammarQuestions: GrammarFillQuestion[] }> {
  const {
    passage,
    readingQuestions,
    grammarQuestions,
    readingFailedIdx,
    grammarFailedIdx,
    config,
    complete,
    profileId,
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
              passages: [passage],
              failedReadingQuestions: readingOrder.map((i) => readingQuestions[i]),
              failedGrammarQuestions: grammarOrder.map((i) => grammarQuestions[i]),
            },
          }),
        },
      ],
      schema: generatedPaperStage1Schema,
      maxTokens: 16000,
      profileId,
    })

    // 消费式映射：按 targetWord（小写）分桶，而不是按位置对位——重出提示里阅读、
    // 语法两个列表各自从 1 重新编号，模型换序时位置对位会把 A 词的题面配上 B 词的
    // 答案，错词池会记错词。找不到同词条目就保留原题（一轮止损原则不变）。
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
      // 重出必然是本篇文章——忽略模型回的 passageIndex（阶段一提示词教过
      // 「重出时 passageIndex 一律填 0」，这里本就只有这一篇）
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
  /**
   * 失败组里能识别出 AI 错误码的那部分（passageId → 错误码）。典型场景：钉住的
   * 出题模型被停用/删除（AI_PROFILE_NOT_AVAILABLE）——UI 据此把「没写成」的原因
   * 说对（引导去设置），而不是默认的「上次生成中断了」。识别不出的失败不进这张表。
   */
  missingErrorCodes: Record<string, AiErrorCode>
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
  /** 出题模型硬指定（设置项 quiz_ai_profile_id），见 transport.ts profileId 说明；不传 = 跟随自动路由 */
  profileId?: string
}): Promise<GenerateExplanationsResult> {
  const { quiz, profileId } = opts
  const onProgress = opts.onProgress ?? (() => {})
  const complete = opts.complete ?? defaultCompleteStructured
  const groups = regroupForExplanations(quiz)
  const tracesByPassageId = new Map((opts.traces ?? []).map((t) => [t.passageId, t]))

  const updatedReading = new Map(quiz.readingQuestions.map((q) => [q.id, q]))
  const updatedGrammar = new Map(quiz.grammarQuestions.map((q) => [q.id, q]))
  const missingPassageIds: string[] = []
  const missingErrorCodes: Record<string, AiErrorCode> = {}

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
          profileId,
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
      } catch (error) {
        // 这一组解析生成失败：不抛出、不影响其它组，留给 UI「点击补生成」兜底
        missingPassageIds.push(group.passage.id)
        const code = getAiErrorCode(error)
        if (code) missingErrorCodes[group.passage.id] = code
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
    missingErrorCodes,
  }
}
