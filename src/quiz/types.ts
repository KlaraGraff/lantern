/**
 * 词卷 · 领域模型（本模块唯一的类型契约）
 *
 * 迁自 labs/cijuan/src/types.ts（提交 5f15860）。所有词卷模块（prompts / schemas /
 * generate / judge / grading）只从这里引类型。改这里 = 改数据契约，需要主会话审查。
 *
 * 相对原版的裁剪：
 * - 去掉 AiProfile / ProviderId / AppSettings / DEFAULT_SETTINGS —— 这些属于
 *   词卷独立版「自带 key」的服务商目录，Lantern 换成 ai_profiles + secrets.db +
 *   故障切换（后端 ai_complete_text 内部路由），前端不再持有服务商/模型/key。
 * - 去掉 ReadingQuestion / GrammarFillQuestion 上的 `explanation?: string`
 *   （旧版一段式讲解，结构化讲解字段上线前的存量卷兼容字段）—— 拍板 C：独立版
 *   旧数据不迁移，这层兼容在 Lantern 里没有意义。
 * - GrammarFillQuestion 新增 `passageId`：两阶段生成（解析后台续写）需要按「同一次
 *   出题调用」重新分组，阅读题天然有 passageId，语法题原来没有；这次生成时它们
 *   与某一篇文章的阅读题同属一次调用，补上这个字段使分组可从 Quiz 本身重建，
 *   不需要额外持久化「生成会话」状态。
 * - ReadingQuestion / GrammarFillQuestion 新增可选 `answerDispute`：阶段二讲解生成
 *   的泄压阀字段（见 generate.ts / schemas.ts 的说明）。
 */

// ===== 基础枚举 =====

/** 难度风格：决定文章长度、词汇密度、题型口吻 */
export type Difficulty = 'cet4' | 'cet6' | 'ielts' | 'kaoyan'

/** 题型 */
export type QuestionType = 'reading' | 'grammarFill' | 'bankedCloze'

/**
 * 素材来源（二期真题板块的预留字段，v1 一律 'ai-original'）：
 * - ai-original   AI 原创文章
 * - exam-adapted  真题改编（真题文章骨架 + 植入目标词）
 * - exam-verbatim 真题原文
 */
export type MaterialSource = 'ai-original' | 'exam-adapted' | 'exam-verbatim'

/** 词的来路：今日新词 / 生词本导入 / 错词池重现（重现词在卷面上不做标记） */
export type WordOrigin = 'today' | 'vocab' | 'recur'

// ===== 出题配置 =====

export interface QuizConfig {
  difficulty: Difficulty
  /** 勾选的题型，默认 ['reading', 'grammarFill'] */
  types: QuestionType[]
  materialSource: MaterialSource
  /** 生成用的模型 ID（留档），如 claude-opus-5 / deepseek-v4-flash */
  model: string
  /** 遮词自检：生成后遮住目标词重做一遍，仍能答对的题判为无效并重出 */
  maskedCheck: boolean
  /** 演示卷标记：交卷时不写错词池（演示词不该污染真实数据） */
  demo?: boolean
}

export interface QuizWord {
  word: string
  origin: WordOrigin
}

// ===== 文章与题目 =====

export interface Passage {
  id: string
  title: string
  /** 段落数组，溯源用段号（从 1 计）指回这里 */
  paragraphs: string[]
  /** 本篇覆盖的目标词 */
  targetWords: string[]
}

/** 溯源：答案在原文中的出处 */
export interface SourceRef {
  passageId: string
  /** 段号，从 1 计 */
  paragraph: number
  /** 原文引句，UI 用 <mark> 高亮 */
  quote: string
}

export type ChoiceLabel = 'A' | 'B' | 'C' | 'D'

export interface ReadingOption {
  label: ChoiceLabel
  text: string
  /**
   * 选项本身的中文含义（用户报告的主要错因之一是「认不出选项」）。
   * 阶段一（出题）不含此字段；阶段二（解析）生成后才补上，UI 需兜底 undefined。
   */
  meaning?: string
  /** 该选项为何对/为何错：正确项讲词义如何锁定它，干扰项讲它针对哪种误记。阶段二字段 */
  note?: string
}

export interface ReadingQuestion {
  id: string
  type: 'reading'
  passageId: string
  /** 考点词：不认识这个词就做不出这道题 */
  targetWord: string
  stem: string
  /** 题干中文翻译（用户报告的另一错因：看不懂问题在问什么）。阶段二字段 */
  stemTranslation?: string
  /** 怎么下手：一句话解题路径（先看哪、找什么、如何排除）。阶段二字段 */
  howToSolve?: string
  /** 考点词卡：目标词的准确词义 + 一句用法/搭配。阶段二字段 */
  wordNote?: string
  options: ReadingOption[]
  answer: ChoiceLabel
  source: SourceRef
  /**
   * 阶段二讲解生成时的泄压阀：模型无法为这道题的既定答案自圆其说时，
   * 不许改判但可在此举旗说明，UI 需要把这类题标出来（人工复核 / 提示存疑）。
   */
  answerDispute?: string
}

export interface GrammarFillQuestion {
  id: string
  type: 'grammarFill'
  /**
   * 出题时同属一次生成调用的文章 id（该文章的阅读题共享同一个 passageId）。
   * 语法题本身不依赖文章文本（句子是独立新写的），这个字段只用于阶段二解析
   * 生成时按「同一次调用」重新分组、续写同一段对话，不作为 UI 展示依据。
   */
  passageId: string
  /** 考点词：不认识这个词就填不出正确形态 */
  targetWord: string
  /** 含空格的句子，空格用 ____ 表示 */
  sentence: string
  /** 整句中文翻译。阶段二字段 */
  sentenceTranslation?: string
  /** 括号提示的原形，如 allocate */
  hint: string
  /** 标准答案，如 be allocated */
  answer: string
  /** 语法点标签，如 ['现在完成时', '被动语态']。阶段二字段 */
  grammarPoints?: string[]
  /** 判定链：从句中线索到答案形态的推理步骤，按顺序排列。阶段二字段 */
  reasoning?: string[]
  /** 常见错误形态与各自错因。阶段二字段 */
  wrongForms?: { form: string; note: string }[]
  /** 考点词词义（一句话）。阶段二字段 */
  wordMeaning?: string
  /** 阶段二讲解生成的泄压阀，同 ReadingQuestion.answerDispute */
  answerDispute?: string
}

// ===== 选取追问 =====

/**
 * 评卷页的「选中文本 → 问 AI」追问线程。
 * 刻意保持轻量：无跨卷索引、无独立会话库——Lantern 里这层复用 ai_chat 通道与
 * MessageBubble 渲染，只是不进 Lantern 的聊天历史，随卷保存。
 */
export interface AskMessage {
  role: 'user' | 'assistant'
  content: string
  /** ISO 时间串 */
  at: string
}

export interface AskThread {
  id: string
  /** 用户选中的原文片段 */
  quote: string
  /** 片段出处的人类可读标注，如「文章 ¶2」「第 3 题 选项 B」 */
  quoteFrom: string
  /** 发给模型的上下文（所在段落/题目全文），不在 UI 展示 */
  context: string
  messages: AskMessage[]
  /** ISO 时间串 */
  createdAt: string
}

// ===== 试卷 =====

/**
 * `generating`：渐进发卷（docs/impls/quiz-progressive-delivery.md）——首篇文章
 * 就绪时卷子就落库进人手上了，其余篇还在生成/失败待重生成。此状态下交卷被
 * 前后端双重拒绝；全部篇就绪后翻成 `ready`，行数据与非渐进卷完全同形。
 */
export type QuizStatus = 'generating' | 'ready' | 'submitted'

/** 生成计划里一个篇位（词组）的状态；重启后 pending 与 failed 同等对待（都不在跑）。 */
export type QuizGenerationGroupState = 'pending' | 'failed' | 'done'

/** generation_json 里的一个篇位：拆词时定死的词组 + 当前状态。篇号 = 数组下标。 */
export interface QuizGenerationGroup {
  words: QuizWord[]
  state: QuizGenerationGroupState
  /** done 时回填：把篇位映射到 content 里的文章 */
  passageId?: string
  /** failed 且能识别出 AI 错误码时记录，UI 据此把失败原因说对 */
  errorCode?: string
  /**
   * failed 时记录底层错误原文（截断到 QUIZ_ERROR_MESSAGE_MAX_CHARS）。
   * errorCode 认得出的失败有现成文案，认不出的（模型输出解析不了、provider
   * 返回 4xx/5xx 原文…）此前在界面上只剩一句「未生成完成」，用户和排查都无从下手
   * ——这一条就是给那种情况兜底的。不含任何凭据：错误原文来自 provider 响应与
   * 解析异常，密钥不在其中。
   */
  errorMessage?: string
}

/** generation_json 的形状（前端独占读写，见 paper-io.ts 顶注） */
export interface QuizGenerationPlan {
  groups: QuizGenerationGroup[]
}

export interface Quiz {
  /** SQLite 自增主键，新建未落库前为 undefined */
  id?: number
  /** ISO 时间串 */
  createdAt: string
  config: QuizConfig
  words: QuizWord[]
  passages: Passage[]
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  status: QuizStatus
  /** 生成计划；只在 status === 'generating' 时存在（rowToQuiz 从 generation_json 解析） */
  generation?: QuizGenerationPlan
  result?: QuizResult
  /** 评卷页的追问记录，随卷保存 */
  askThreads?: AskThread[]
  /** 未交卷的做题草稿（答案自动保存），交卷时后端清掉 */
  draft?: QuizDraft
}

/** draft_json 的形状（前端独占读写，见 paper-io.ts 顶注）：
 *  做题页边做边存的草稿——已填答案 + 已累计的前台活跃用时。 */
export interface QuizDraft {
  answers: AnswerSheet
  elapsedMs: number
}

// ===== 作答与判分 =====

/** 用户对整卷的作答：questionId -> 所选项字母或填空文本 */
export type AnswerSheet = Record<string, string>

export interface QuestionVerdict {
  questionId: string
  targetWord: string
  correct: boolean
  userAnswer: string
  correctAnswer: string
  /** 语法填空由 LLM 判分时的补充说明（如接受了变体拼写） */
  judgeNote?: string
}

export interface QuizResult {
  submittedAt: string
  verdicts: QuestionVerdict[]
  /** 答对题数 */
  score: number
  total: number
  /** 判错题对应的考点词（去重），交卷后进错词池 */
  wrongWords: string[]
}

// ===== 错词池 =====

/**
 * 重现阶段机：
 *   答错 → stage 0，nextDueAt = +2 天
 *   stage 0 重现答对 → stage 1，nextDueAt = +7 天
 *   stage 1 重现答对 → cleared，出池
 *   任意时刻再答错 → 回 stage 0，nextDueAt = +2 天，wrongCount+1
 *
 * 状态机本身移植到 Rust（见 docs/impls/cijuan-merge.md §二.3），这里的类型仅供
 * 前端展示错词池数据用。
 */
export type WrongWordStage = 0 | 1

export interface WrongWordEntry {
  id?: number
  word: string
  wrongCount: number
  firstWrongAt: string
  lastWrongAt: string
  stage: WrongWordStage
  /** 下次应重现的时间；cleared 后为 null */
  nextDueAt: string | null
  cleared: boolean
}

/** 每篇文章覆盖的目标词数范围（超出则拆多篇） */
export const WORDS_PER_PASSAGE = { min: 8, max: 12 }
