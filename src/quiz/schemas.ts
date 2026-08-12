import { z } from 'zod'

/**
 * LLM 结构化输出的 zod schema。
 * 与 ./types.ts 中的领域类型一一对应，但只描述「模型该返回什么」，
 * id 等由本地补齐的字段不在此列。
 *
 * 迁自 labs/cijuan/src/llm/schemas.ts，按两阶段生成拆分（docs/impls/cijuan-merge.md
 * §二.6）：
 * - 阶段一（generatedPaperStage1Schema）：文章 + 题干/选项/答案/溯源，不含任何
 *   讲解字段。
 * - 明答校验（answerCheckSchema）：新增，阶段一收卷前的质检。
 * - 阶段二（generatedExplanationsSchema）：新增，全部讲解字段 + 每题可选
 *   answerDispute（泄压阀，不许改判、只许举旗）。
 */

export const choiceLabelSchema = z.enum(['A', 'B', 'C', 'D'])

export const generatedPassageSchema = z.object({
  title: z.string(),
  paragraphs: z.array(z.string()).describe('文章正文，按段落切分'),
  targetWords: z.array(z.string()).describe('本篇实际植入的目标词'),
})

// ===== 阶段一：出题（不含解析字段） =====

export const readingOptionStage1Schema = z.object({
  label: choiceLabelSchema,
  text: z.string(),
})

export const generatedReadingQuestionStage1Schema = z.object({
  passageIndex: z.number().int().describe('题目所属文章的下标，从 0 计'),
  targetWord: z.string(),
  stem: z.string(),
  options: z.array(readingOptionStage1Schema).describe('四个选项，label 依次为 A B C D'),
  answer: choiceLabelSchema,
  sourceParagraph: z.number().int().describe('答案依据所在段号，从 1 计'),
  sourceQuote: z.string().describe('答案依据的原文引句，须与原文逐字一致'),
})

export const generatedGrammarQuestionStage1Schema = z.object({
  targetWord: z.string(),
  sentence: z.string().describe('含 ____ 空格的完整句子'),
  hint: z.string().describe('括号提示的原形，如 allocate'),
  answer: z.string().describe('标准答案，如 be allocated'),
})

/** 阶段一：一次生成调用返回的整卷内容（不含解析） */
export const generatedPaperStage1Schema = z.object({
  passages: z.array(generatedPassageSchema),
  readingQuestions: z.array(generatedReadingQuestionStage1Schema),
  grammarQuestions: z.array(generatedGrammarQuestionStage1Schema),
})

export type GeneratedPaperStage1 = z.infer<typeof generatedPaperStage1Schema>

// ===== 明答校验（阶段一收卷前的新增质检） =====

/**
 * 明答校验的选项字母容错：模型常给 "b"、"B."、" B "这类变体而不是纯粹的
 * "A"|"B"|"C"|"D"——trim、去掉尾部标点、转大写后再进枚举，格式误差不该
 * 让这道题被误判为「答不上来」进而触发不必要的重出。
 */
const tolerantChoiceLabelSchema = z.preprocess((val) => {
  if (typeof val !== 'string') return val
  return val.trim().replace(/[.。、,，]+$/, '').toUpperCase()
}, choiceLabelSchema)

export const answerCheckSchema = z.object({
  readingAnswers: z.array(
    z.object({
      questionIndex: z.number().int().describe('阅读题下标，从 0 计'),
      answer: tolerantChoiceLabelSchema.describe('你自己重做后选的答案'),
    }),
  ),
  // 默认空数组：语法题为空/字段缺失不该让整个明答校验解析失败——没有语法题
  // 的卷子本就不会有 grammarAnswers，缺省等价于「没有语法题要报」
  grammarAnswers: z
    .array(
      z.object({
        questionIndex: z.number().int().describe('语法填空题下标，从 0 计'),
        answer: z.string().describe('你自己重做后填入的形态'),
      }),
    )
    .default([]),
})

export type AnswerCheckResult = z.infer<typeof answerCheckSchema>

// ===== 阶段二：解析生成 =====

export const explanationOptionSchema = z.object({
  label: choiceLabelSchema,
  meaning: z.string().describe('该选项本身的中文含义'),
  note: z
    .string()
    .describe('该选项为何对/为何错：正确项讲词义如何锁定它，干扰项讲它针对哪种误记设陷'),
})

export const readingExplanationSchema = z.object({
  questionIndex: z.number().int().describe('本组 readingQuestions 内的下标，从 0 计'),
  stemTranslation: z.string().describe('题干的中文翻译，忠实通顺'),
  howToSolve: z
    .string()
    .describe('怎么下手：一句话解题路径（先看哪、找什么线索、如何排除），中文'),
  wordNote: z.string().describe('考点词卡：目标词的准确中文词义 + 一句用法或搭配'),
  options: z.array(explanationOptionSchema).describe('与题目选项一一对应，按 A B C D 顺序'),
  // .nullish()（而非 .optional()）：提示词允许「留空字符串」，但模型更常直接给 null
  // 表示「没有异议」——按 .optional() 校验会整题被拒，进而拖累整组解析被判失败。
  answerDispute: z
    .string()
    .nullish()
    .describe('无法为既定答案自圆其说时的举旗说明；不许据此改判，没有异议则不填'),
})

export const grammarExplanationSchema = z.object({
  questionIndex: z.number().int().describe('本组 grammarQuestions 内的下标，从 0 计'),
  sentenceTranslation: z.string().describe('整句（含答案填入后）的中文翻译'),
  grammarPoints: z
    .array(z.string())
    .describe('考到的语法点标签，1-3 个，如 ["现在完成时", "被动语态"]'),
  reasoning: z
    .array(z.string())
    .describe('判定链：从句中线索推到答案形态的步骤，每步一句中文，按顺序 2-4 步'),
  wrongForms: z
    .array(z.object({ form: z.string(), note: z.string().describe('这样填为什么错，中文一句话') }))
    .describe('考生最可能误填的 1-3 个形态及各自错因'),
  wordMeaning: z.string().describe('考点词的中文词义，一句话'),
  // 同上：.nullish() 兼容模型给 null 表示「没有异议」的常见输出
  answerDispute: z
    .string()
    .nullish()
    .describe('无法为既定答案自圆其说时的举旗说明；不许据此改判，没有异议则不填'),
})

/** 阶段二：一组（一篇文章 + 它的题）的解析续写结果 */
export const generatedExplanationsSchema = z.object({
  // 默认空数组，与 answerCheckSchema.grammarAnswers 的处理对齐：纯阅读卷
  // （config.types 不含 grammarFill）时模型可能整个省略 grammarExplanations，
  // 不该让整组解析因为缺一个空数组字段就被拒收
  readingExplanations: z.array(readingExplanationSchema).default([]),
  grammarExplanations: z.array(grammarExplanationSchema).default([]),
})

export type GeneratedExplanations = z.infer<typeof generatedExplanationsSchema>

// ===== 遮词自检 =====

/** 遮词自检：每道阅读题一个裁决（全局索引，覆盖整卷 readingQuestions） */
export const maskedCheckVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      questionIndex: z.number().int().describe('题目下标，从 0 计'),
      answeredWithoutWord: choiceLabelSchema.describe('遮住目标词后你选的答案'),
      confident: z.boolean().describe('遮住目标词后是否仍能有把握地选出该答案'),
    }),
  ),
})

export type MaskedCheckResult = z.infer<typeof maskedCheckVerdictSchema>

// ===== 语法判分（评卷阶段，与生成两阶段无关） =====

/** 语法填空判分（本地字符串比对失败后，交给模型裁决变体） */
export const grammarJudgeSchema = z.object({
  verdicts: z.array(
    z.object({
      questionIndex: z.number().int(),
      correct: z.boolean(),
      note: z.string().describe('一句话中文说明：为何判对/判错'),
    }),
  ),
})

export type GrammarJudgeResult = z.infer<typeof grammarJudgeSchema>
