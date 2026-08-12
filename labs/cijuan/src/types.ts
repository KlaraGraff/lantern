/**
 * 词卷 · 领域模型（全项目唯一的类型契约）
 *
 * 所有模块（LLM 服务 / 存储 / UI）只从这里引类型。
 * 改这里 = 改数据契约，需要主会话审查。
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

/** 词的来路：今日新词 / 错词池重现（重现词在卷面上不做标记） */
export type WordOrigin = 'today' | 'recur'

// ===== AI 服务商 =====

/** 服务商目录见 src/llm/providers.ts（照搬 Lantern 的自带 key 模式） */
export type ProviderId = 'anthropic' | 'deepseek' | 'openai' | 'ollama' | 'lmstudio' | 'custom'

/** 用户配置的 AI 线路：服务商 + 端点 + 模型 + key，全部本机保存 */
export interface AiProfile {
  provider: ProviderId
  /** 留空 = 用服务商默认端点 */
  baseUrl: string
  model: string
  /** 本地模型服务（ollama / lmstudio）无需 key */
  apiKey: string
}

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
   * 生成期必填；对旧数据（结构化讲解上线前的卷）可能缺失，UI 需兜底。
   */
  meaning?: string
  /** 该选项为何对/为何错：正确项讲词义如何锁定它，干扰项讲它针对哪种误记 */
  note?: string
}

export interface ReadingQuestion {
  id: string
  type: 'reading'
  passageId: string
  /** 考点词：不认识这个词就做不出这道题 */
  targetWord: string
  stem: string
  /** 题干中文翻译（用户报告的另一错因：看不懂问题在问什么） */
  stemTranslation?: string
  /** 怎么下手：一句话解题路径（先看哪、找什么、如何排除） */
  howToSolve?: string
  /** 考点词卡：目标词的准确词义 + 一句用法/搭配 */
  wordNote?: string
  options: ReadingOption[]
  answer: ChoiceLabel
  /** 旧版一段式讲解（结构化字段上线前的存量卷）；新卷不再生成 */
  explanation?: string
  source: SourceRef
}

export interface GrammarFillQuestion {
  id: string
  type: 'grammarFill'
  targetWord: string
  /** 含空格的句子，空格用 ____ 表示 */
  sentence: string
  /** 整句中文翻译 */
  sentenceTranslation?: string
  /** 括号提示的原形，如 allocate */
  hint: string
  /** 标准答案，如 be allocated */
  answer: string
  /** 语法点标签，如 ['现在完成时', '被动语态'] */
  grammarPoints?: string[]
  /** 判定链：从句中线索到答案形态的推理步骤，按顺序排列 */
  reasoning?: string[]
  /** 常见错误形态与各自错因，如 { form: 'advocated', note: '漏掉 have，丢了完成时' } */
  wrongForms?: { form: string; note: string }[]
  /** 考点词词义（一句话） */
  wordMeaning?: string
  /** 旧版一段式讲解（存量卷兼容）；新卷不再生成 */
  explanation?: string
}

// ===== 选取追问 =====

/**
 * 评卷页的「选中文本 → 问 AI」追问线程。
 * 刻意保持轻量：无跨卷索引、无独立会话库——将来并入 Lantern 时
 * 这层会被它的 AiPanel 与数据层替换，可迁移资产是 Quiz 里的原始数据。
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

export type QuizStatus = 'ready' | 'submitted'

export interface Quiz {
  /** Dexie 自增主键 */
  id?: number
  /** ISO 时间串 */
  createdAt: string
  config: QuizConfig
  words: QuizWord[]
  passages: Passage[]
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
  status: QuizStatus
  result?: QuizResult
  /** 评卷页的追问记录，随卷保存 */
  askThreads?: AskThread[]
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
 */
export type WrongWordStage = 0 | 1

export interface WrongWordEntry {
  /** Dexie 自增主键 */
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

// ===== 设置 =====

export interface AppSettings {
  /** AI 线路（服务商 + 端点 + 模型 + key），存 localStorage */
  profile: AiProfile
  /** 演示模式：不调 API，用内置样卷跑完整流程 */
  demoMode: boolean
  maskedCheck: boolean
  difficulty: Difficulty
  types: QuestionType[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  profile: { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5', apiKey: '' },
  demoMode: false,
  maskedCheck: true,
  difficulty: 'cet6',
  types: ['reading', 'grammarFill'],
}

/** 每篇文章覆盖的目标词数范围（超出则拆多篇） */
export const WORDS_PER_PASSAGE = { min: 8, max: 12 }
