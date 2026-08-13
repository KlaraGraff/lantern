/**
 * 渐进发卷会话（docs/impls/quiz-progressive-delivery.md §四）。
 *
 * 照 explanation-session.ts 的模块级单例样式（跨路由存活、useSyncExternalStore
 * 订阅）：出卷屏点「生成」后用户随首篇就绪跳去做题页，其余篇的生成、落库、
 * 解析续写都必须在路由之外继续跑。
 *
 * 三条职责，三条链：
 *
 * 1. **编排**：startGenerationSession 调 generateQuiz（按篇流水线，见
 *    generate.ts），把进度事件聚合成会话状态；regenerateArticles 对失败/中断
 *    的篇调 generateArticle 走同一段落库代码——重启后的冷启动（内存会话已死）
 *    从落库的 generation_json 重建会话，与热路径同代码。
 * 2. **单写者（writeChain）**：一张卷的所有 DB 写——建卷、按篇写回
 *    （update_quiz_paper_generation）、解析写回（update_quiz_paper_content）——
 *    全部串在会话内部的 promise 链上；会话内存里持有权威 Quiz，每次写库前先把
 *    改动合并进它再序列化。天然避免「解析写回的旧快照覆盖掉后落的新篇」竞态。
 * 3. **逐篇解析（explanationChain）**：每篇落库后立刻用该篇的 trace 起
 *    runExplanationSession({ onlyPassageIds: [该篇] })——正好在 DeepSeek 前缀
 *    缓存时效内。explanation-session 有同卷 running 互斥，这里把逐篇调用串成
 *    链保证一次只有一轮；其 persist 注入为「合并进权威 Quiz 再走写链」。
 *
 * 落库节奏（首篇就绪即进卷）：首个 ok 篇 → create_quiz_paper（若此刻全组已
 * done 则直接建 ready 卷——单篇卷自动退化为旧行为）；后续篇按组序插入权威
 * Quiz 后整行写回；失败篇只更新 generation_json 里的状态。全部 done →
 * status 'ready'、generation_json 清 NULL，行数据与非渐进卷完全同形。
 *
 * 取消只在建卷前有意义（建卷后即跳转，生成中屏已不在）：置 cancelled 标志 +
 * 逐 id cancelRequest；写链每个环节先自查 cancelled，杜绝「取消瞬间还是建了
 * 卷」的竞态。
 */
import { invoke } from '@tauri-apps/api/core'
import {
  generateArticle,
  generateQuiz,
  type ArticleOutcome,
  type ArticleStep,
  type CompleteStructured,
  type GenerationTrace,
} from '../../quiz/generate.ts'
import { splitWords } from '../../quiz/split.ts'
import { cancelRequest } from '../../quiz/transport.ts'
import type {
  GrammarFillQuestion,
  Passage,
  Quiz,
  QuizConfig,
  QuizGenerationGroupState,
  QuizWord,
  ReadingQuestion,
} from '../../quiz/types.ts'
import { getAiErrorCode, isAiErrorCode, type AiErrorCode } from '../../utils/aiError.ts'
import { mergeQuizQuestions, runExplanationSession } from './explanation-session.ts'
import { quizContentJson } from './paper-io.ts'

/** 生成中屏的宏观阶段：拆词中 → 各篇流水线推进中 → 发卷（新卷会话随即导航离开） */
export type GenerationStage = 'splitting' | 'articles' | 'done'

/**
 * 按篇状态行。`pending` 存在于 split 建行到该篇首个 article 事件之间，以及
 * 重生成会话里「本轮没被点名」的篇——UI 对后者按落库的组状态展示，不看这里。
 */
export interface ArticleProgress {
  wordCount: number
  step: ArticleStep | 'pending'
}

export interface GenerationSessionState {
  /** 有流水线在跑（含收尾写库）。翻 false 的时机在最后一次写库之后。 */
  running: boolean
  stage: GenerationStage
  articles: ArticleProgress[]
  /** 首个 ok 篇落库后出现；新卷会话的订阅方（useQuizGeneration）据此导航 */
  paperId: number | null
  /** 全部篇都失败（建卷前整体失败）时的错误信息；建卷后不再有整体错误 */
  error: string | null
  errorCode: AiErrorCode | null
  /** 每次写库成功 +1；做题页据此静默重拉（load({silent:true})） */
  revision: number
}

/** 一个篇位的会话内部状态；`article` 在 done 时持有该篇的结构化产物 */
interface SessionGroup {
  words: QuizWord[]
  state: QuizGenerationGroupState
  errorCode?: AiErrorCode
  passageId?: string
  trace?: GenerationTrace
  article?: {
    passage: Passage
    readingQuestions: ReadingQuestion[]
    grammarQuestions: GrammarFillQuestion[]
    /** 该篇实际考到的词（按篇覆盖结算，words_json 只累计 done 篇的这一份） */
    coveredWords: QuizWord[]
  }
}

/** 测试注入点：三条 DB 写路径。真实调用一律省略，落回 Tauri invoke。 */
export interface GenerationIo {
  createPaper(args: {
    createdAt: string
    status: string
    configJson: string
    wordsJson: string
    contentJson: string
    generationJson: string | null
  }): Promise<number>
  updateGeneration(args: {
    id: number
    contentJson: string
    wordsJson: string
    status: string
    generationJson: string | null
  }): Promise<void>
  updateContent(id: number, contentJson: string): Promise<void>
}

const defaultIo: GenerationIo = {
  createPaper: (args) => invoke<number>('create_quiz_paper', args),
  updateGeneration: (args) => invoke('update_quiz_paper_generation', args),
  updateContent: (id, contentJson) => invoke('update_quiz_paper_content', { id, contentJson }),
}

interface Session {
  paperId: number | null
  createdAt: string | null
  config: QuizConfig
  profileId?: string
  groups: SessionGroup[]
  /** 权威 Quiz：所有写库都从它序列化；解析字段的唯一活体也在这里 */
  quiz: Quiz | null
  writeChain: Promise<void>
  explanationChain: Promise<void>
  registry: Set<string>
  cancelled: boolean
  state: GenerationSessionState
  io: GenerationIo
  runExplanations: typeof runExplanationSession
  complete?: CompleteStructured
}

/** 新卷会话（尚无 paperId 时唯一的入口）；建卷后同一对象也登记进 paperSessions */
let newPaperSession: Session | null = null
const paperSessions = new Map<number, Session>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function setState(session: Session, patch: Partial<GenerationSessionState>) {
  session.state = { ...session.state, ...patch }
  notify()
}

/** useSyncExternalStore 的 subscribe；返回退订函数。 */
export function subscribeGenerationSessions(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 新卷会话的快照（getSnapshot）；对象引用仅在状态变化时更换。 */
export function getNewPaperGeneration(): GenerationSessionState | null {
  return newPaperSession?.state ?? null
}

/** 指定卷的会话快照（做题页订阅重生成/后台补篇进度用）。 */
export function getPaperGeneration(paperId: number): GenerationSessionState | undefined {
  return paperSessions.get(paperId)?.state
}

/** 只留给测试重置模块态用。 */
export function resetGenerationSessions() {
  newPaperSession = null
  paperSessions.clear()
}

function createSession(opts: {
  config: QuizConfig
  profileId?: string
  complete?: CompleteStructured
  io?: GenerationIo
  runExplanations?: typeof runExplanationSession
}): Session {
  return {
    paperId: null,
    createdAt: null,
    config: opts.config,
    profileId: opts.profileId,
    groups: [],
    quiz: null,
    writeChain: Promise.resolve(),
    explanationChain: Promise.resolve(),
    registry: new Set(),
    cancelled: false,
    io: opts.io ?? defaultIo,
    runExplanations: opts.runExplanations ?? runExplanationSession,
    complete: opts.complete,
    state: {
      running: true,
      stage: 'splitting',
      articles: [],
      paperId: null,
      error: null,
      errorCode: null,
      revision: 0,
    },
  }
}

/**
 * 单写者入队：所有 DB 写都经这里串行。环节自身的异常吞掉不断链（写库失败的
 * 恢复口径：卷子留在 generating 态 + generation_json 还在，做题页的「继续生成」
 * 能把它救回来；让链断掉反而把后续篇也拖下水）。建卷失败例外，见 persistStructural。
 */
function enqueueWrite(session: Session, op: () => Promise<void>): Promise<void> {
  session.writeChain = session.writeChain.then(async () => {
    if (session.cancelled) return
    try {
      await op()
    } catch (err) {
      console.error('generation session write failed:', err)
    }
  })
  return session.writeChain
}

function planJson(session: Session): string {
  return JSON.stringify({
    groups: session.groups.map((g) => ({
      words: g.words,
      state: g.state,
      ...(g.passageId ? { passageId: g.passageId } : {}),
      ...(g.errorCode ? { errorCode: g.errorCode } : {}),
    })),
  })
}

/**
 * 从组状态重建权威 Quiz：篇序 = 组序（与按篇解锁规则一致），words 只累计
 * done 篇的覆盖词（按篇覆盖结算）。已写回的解析字段活在 session.quiz 里，
 * 重建后按题 id 收回来（mergeQuizQuestions），不会被结构重建冲掉。
 */
function buildQuiz(session: Session): Quiz {
  const passages: Passage[] = []
  const readingQuestions: ReadingQuestion[] = []
  const grammarQuestions: GrammarFillQuestion[] = []
  const words: QuizWord[] = []
  for (const g of session.groups) {
    if (g.state !== 'done' || !g.article) continue
    passages.push(g.article.passage)
    readingQuestions.push(...g.article.readingQuestions)
    grammarQuestions.push(...g.article.grammarQuestions)
    words.push(...g.article.coveredWords)
  }
  const allDone = session.groups.every((g) => g.state === 'done')
  const rebuilt: Quiz = {
    id: session.paperId ?? undefined,
    createdAt: session.createdAt ?? new Date().toISOString(),
    config: session.config,
    words,
    passages,
    readingQuestions,
    grammarQuestions,
    status: allDone ? 'ready' : 'generating',
  }
  return session.quiz ? mergeQuizQuestions(rebuilt, session.quiz) : rebuilt
}

/**
 * 结构化落库（writeChain 环节）：无 paperId → 建卷（首篇就绪即进卷的那一步，
 * 全组已 done 时直接建 ready 卷）；有 → 一条 UPDATE 同步推进
 * content/words/status/generation 四列。
 */
async function persistStructural(session: Session): Promise<void> {
  if (session.paperId == null) {
    session.createdAt = new Date().toISOString()
  }
  const quiz = buildQuiz(session)
  session.quiz = quiz
  const generationJson = quiz.status === 'ready' ? null : planJson(session)
  if (session.paperId == null) {
    let id: number
    try {
      id = await session.io.createPaper({
        createdAt: session.createdAt!,
        status: quiz.status,
        configJson: JSON.stringify(session.config),
        wordsJson: JSON.stringify(quiz.words),
        contentJson: quizContentJson(quiz),
        generationJson,
      })
    } catch (err) {
      // 建卷失败没有「留在 generating 态」可退：DB 里根本没有这张卷。当成
      // 整体失败上屏（与旧版 create 失败走 error 屏的行为一致），会话就此停摆。
      console.error('generation session failed to create paper:', err)
      session.cancelled = true
      for (const requestId of session.registry) void cancelRequest(requestId).catch(() => {})
      session.registry.clear()
      const message = err instanceof Error ? err.message : String(err)
      setState(session, {
        running: false,
        error: message,
        errorCode: getAiErrorCode(err),
      })
      return
    }
    session.paperId = id
    session.quiz = { ...quiz, id }
    paperSessions.set(id, session)
    setState(session, { paperId: id, revision: session.state.revision + 1 })
  } else {
    await session.io.updateGeneration({
      id: session.paperId,
      contentJson: quizContentJson(quiz),
      wordsJson: JSON.stringify(quiz.words),
      status: quiz.status,
      generationJson,
    })
    setState(session, { revision: session.state.revision + 1 })
  }
}

/** 一条流水线 settle 的会话侧处理：更新组状态 → 入队落库 → （ok 时）排队解析 */
function onArticleOutcome(session: Session, outcome: ArticleOutcome) {
  const group = session.groups[outcome.index]
  if (!group) return
  if (outcome.ok && outcome.passage && outcome.trace) {
    const covered = new Set(
      [...outcome.readingQuestions, ...outcome.grammarQuestions].map((q) =>
        q.targetWord.toLowerCase(),
      ),
    )
    group.state = 'done'
    group.errorCode = undefined
    group.passageId = outcome.passage.id
    group.trace = outcome.trace
    group.article = {
      passage: outcome.passage,
      readingQuestions: outcome.readingQuestions,
      grammarQuestions: outcome.grammarQuestions,
      coveredWords: outcome.words.filter((w) => covered.has(w.word.toLowerCase())),
    }
    void enqueueWrite(session, () => persistStructural(session))
    queueExplanation(session, outcome.passage.id, outcome.trace)
  } else {
    group.state = 'failed'
    group.errorCode = outcome.errorCode ?? undefined
    void enqueueWrite(session, async () => {
      // 建卷前的失败只活在会话状态里（届时 generation_json 随建卷一起写入）
      if (session.paperId == null) return
      await persistStructural(session)
    })
  }
}

/**
 * 逐篇解析入队：等本篇的结构化落库完成（paperId 必然已就绪）再起
 * runExplanationSession——explanation-session 有同卷 running 互斥，串成链
 * 保证一次只有一轮。persist 注入为「合并进权威 Quiz 再走写链」：
 * runExplanationSession 交来的 merged 基于它开跑时的快照，期间若有新篇落库，
 * 快照是旧的——mergeQuizQuestions 按题 id 把解析字段收进最新权威 Quiz，
 * 新篇的题不在 merged 里、原样保留，竞态就此消解。
 */
function queueExplanation(session: Session, passageId: string, trace: GenerationTrace) {
  // 捕获此刻的写链：它已包含本篇的结构化落库环节
  const structuralWritten = session.writeChain
  session.explanationChain = session.explanationChain.then(async () => {
    await structuralWritten
    if (session.cancelled || session.paperId == null || !session.quiz) return
    await session.runExplanations({
      paperId: session.paperId,
      quiz: session.quiz,
      traces: [trace],
      onlyPassageIds: [passageId],
      complete: session.complete,
      profileId: session.profileId,
      persist: (paperId, merged) =>
        new Promise<void>((resolve, reject) => {
          session.writeChain = session.writeChain.then(async () => {
            if (session.cancelled) {
              resolve()
              return
            }
            try {
              session.quiz = mergeQuizQuestions(session.quiz!, merged)
              // 解析只动 content_json，走无 status 门的内容写回：交卷后补上的
              // 解析也要能落库（评卷页读的就是它），update_quiz_paper_generation
              // 的 submitted 拒绝门在这里反而是错的
              await session.io.updateContent(paperId, quizContentJson(session.quiz))
              setState(session, { revision: session.state.revision + 1 })
              resolve()
            } catch (err) {
              // reject 交回 runExplanationSession 的 catch：该组记入
              // missingPassageIds，评卷页给「点击补生成」
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
        }),
    })
  })
}

function updateArticleStep(session: Session, index: number, step: ArticleStep) {
  setState(session, {
    articles: session.state.articles.map((a, i) => (i === index ? { ...a, step } : a)),
  })
}

/**
 * 出卷入口（fire-and-forget）：拆词 → 按篇流水线 → 每篇 settle 即落库。
 * 首个 ok 篇建卷后 state.paperId 出现，订阅方（useQuizGeneration）据此导航；
 * 全部篇都失败时不建卷，error/errorCode 上屏（生成失败屏路径保留）。
 */
export function startGenerationSession(opts: {
  words: QuizWord[]
  config: QuizConfig
  profileId?: string
  /** 测试注入点，穿透给 generateQuiz/generateArticle 与解析续写 */
  complete?: CompleteStructured
  /** 测试注入点，默认走 Tauri invoke */
  io?: GenerationIo
  /** 测试注入点，默认 runExplanationSession */
  runExplanations?: typeof runExplanationSession
}): void {
  // 出卷屏在生成中不给第二个入口，这里再兜一层
  if (newPaperSession?.state.running) return

  const session = createSession(opts)
  // 自行拆词（与 generateQuiz 内部同一纯函数、同一输入，结果确定性一致）：
  // 生成计划需要每组的词面，而进度事件只报词数
  session.groups = splitWords(opts.words).map((words) => ({ words, state: 'pending' as const }))
  newPaperSession = session
  notify()

  void (async () => {
    try {
      await generateQuiz({
        words: opts.words,
        config: opts.config,
        profileId: opts.profileId,
        complete: opts.complete,
        requestRegistry: session.registry,
        onProgress: (p) => {
          if (session.cancelled) return
          if (p.type === 'splitting') {
            setState(session, { stage: 'splitting', articles: [] })
          } else if (p.type === 'split') {
            setState(session, {
              stage: 'articles',
              articles: p.articles.map((a) => ({ wordCount: a.wordCount, step: 'pending' })),
            })
          } else if (p.type === 'article') {
            updateArticleStep(session, p.index, p.step)
          } else {
            setState(session, { stage: 'done' })
          }
        },
        onArticle: (outcome) => onArticleOutcome(session, outcome),
      })
      await session.writeChain
      if (session.cancelled) return
      setState(session, { running: false, stage: 'done' })
    } catch (err) {
      if (session.cancelled) return
      console.error('Quiz generation failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      setState(session, {
        running: false,
        error: message,
        errorCode: getAiErrorCode(err),
      })
    }
  })()
}

/**
 * 取消新卷生成。只在建卷前有意义（建卷后即跳转，生成中屏已不在）；
 * cancelled 标志 + 写链自查双保险，杜绝「取消瞬间还是建了卷」。
 */
export function cancelGenerationSession(): void {
  const session = newPaperSession
  if (!session || session.paperId != null) return
  session.cancelled = true
  for (const requestId of session.registry) void cancelRequest(requestId).catch(() => {})
  session.registry.clear()
  newPaperSession = null
  notify()
}

/** 错误屏「返回出卷」：清掉已停摆的新卷会话（跑着的不动，那是取消的事）。 */
export function dismissGenerationSession(): void {
  if (!newPaperSession || newPaperSession.state.running) return
  newPaperSession = null
  notify()
}

/**
 * 继续生成 / 单篇重新生成（fire-and-forget）：对点名的组跑 generateArticle，
 * 复用同一条落库/解析链。热路径（会话还活着）直接续用权威 Quiz；冷启动
 * （重启后做题页从 generation_json 发起）用落库的卷面 + 生成计划重建会话，
 * 两条路进的是同一段代码。
 */
export function regenerateArticles(opts: {
  paperId: number
  /** 整卷（rowToQuiz 的产物，冷启动时含 generation 计划）；热路径下仅作兜底 */
  quiz: Quiz
  groupIndexes: number[]
  profileId?: string
  /** 测试注入点 */
  complete?: CompleteStructured
  io?: GenerationIo
  runExplanations?: typeof runExplanationSession
}): void {
  let session = paperSessions.get(opts.paperId)
  if (session?.state.running) return
  if (!session) {
    const plan = opts.quiz.generation
    if (!plan) return
    session = createSession({
      config: opts.quiz.config,
      profileId: opts.profileId,
      complete: opts.complete,
      io: opts.io,
      runExplanations: opts.runExplanations,
    })
    session.paperId = opts.paperId
    session.createdAt = opts.quiz.createdAt
    session.quiz = opts.quiz
    // 重启后 pending 与 failed 同等对待（都不在跑，内存会话已死）
    session.groups = plan.groups.map((g) => {
      if (g.state !== 'done' || !g.passageId) {
        return {
          words: g.words,
          state: 'failed' as const,
          errorCode: isAiErrorCode(g.errorCode) ? g.errorCode : undefined,
        }
      }
      const passage = opts.quiz.passages.find((p) => p.id === g.passageId)
      if (!passage) return { words: g.words, state: 'failed' as const }
      const readingQuestions = opts.quiz.readingQuestions.filter(
        (q) => q.passageId === g.passageId,
      )
      const grammarQuestions = opts.quiz.grammarQuestions.filter(
        (q) => q.passageId === g.passageId,
      )
      const covered = new Set(
        [...readingQuestions, ...grammarQuestions].map((q) => q.targetWord.toLowerCase()),
      )
      return {
        words: g.words,
        state: 'done' as const,
        passageId: g.passageId,
        article: {
          passage,
          readingQuestions,
          grammarQuestions,
          coveredWords: g.words.filter((w) => covered.has(w.word.toLowerCase())),
        },
      }
    })
    paperSessions.set(opts.paperId, session)
  }

  const targets = opts.groupIndexes.filter((i) => {
    const g = session!.groups[i]
    return g != null && g.state !== 'done'
  })
  if (targets.length === 0) return

  for (const i of targets) {
    session.groups[i].state = 'pending'
    session.groups[i].errorCode = undefined
  }
  setState(session, {
    running: true,
    stage: 'articles',
    paperId: opts.paperId,
    error: null,
    errorCode: null,
    articles: session.groups.map((g) => ({
      wordCount: g.words.length,
      step: g.state === 'done' ? 'done' : g.state === 'failed' ? 'failed' : 'pending',
    })),
  })

  const fixed = session
  void (async () => {
    await Promise.all(
      targets.map((index) =>
        generateArticle({
          words: fixed.groups[index].words,
          config: fixed.config,
          index,
          onStep: (step) => updateArticleStep(fixed, index, step),
          complete: fixed.complete,
          requestRegistry: fixed.registry,
          profileId: fixed.profileId,
        }).then((outcome) => onArticleOutcome(fixed, outcome)),
      ),
    )
    await fixed.writeChain
    setState(fixed, { running: false, stage: 'done' })
  })()
}
