import { z } from 'zod'

/**
 * LLM 结构化输出的 zod schema。
 * 与 src/types.ts 中的领域类型一一对应，但只描述「模型该返回什么」，
 * id 等由本地补齐的字段不在此列。
 */

export const choiceLabelSchema = z.enum(['A', 'B', 'C', 'D'])

export const generatedPassageSchema = z.object({
  title: z.string(),
  paragraphs: z.array(z.string()).describe('文章正文，按段落切分'),
  targetWords: z.array(z.string()).describe('本篇实际植入的目标词'),
})

export const generatedReadingQuestionSchema = z.object({
  passageIndex: z.number().int().describe('题目所属文章的下标，从 0 计'),
  targetWord: z.string(),
  stem: z.string(),
  stemTranslation: z.string().describe('题干的中文翻译，忠实通顺'),
  howToSolve: z
    .string()
    .describe('怎么下手：一句话解题路径（先看哪、找什么线索、如何排除），中文'),
  wordNote: z.string().describe('考点词卡：目标词的准确中文词义 + 一句用法或搭配'),
  options: z
    .array(
      z.object({
        label: choiceLabelSchema,
        text: z.string(),
        meaning: z.string().describe('该选项本身的中文含义'),
        note: z
          .string()
          .describe('该选项为何对/为何错：正确项讲词义如何锁定它，干扰项讲它针对哪种误记设陷'),
      }),
    )
    .describe('四个选项，label 依次为 A B C D'),
  answer: choiceLabelSchema,
  sourceParagraph: z.number().int().describe('答案依据所在段号，从 1 计'),
  sourceQuote: z.string().describe('答案依据的原文引句，须与原文逐字一致'),
})

export const generatedGrammarQuestionSchema = z.object({
  targetWord: z.string(),
  sentence: z.string().describe('含 ____ 空格的完整句子'),
  sentenceTranslation: z.string().describe('整句（含答案填入后）的中文翻译'),
  hint: z.string().describe('括号提示的原形，如 allocate'),
  answer: z.string().describe('标准答案，如 be allocated'),
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
})

/** 一次生成调用返回的整卷内容 */
export const generatedPaperSchema = z.object({
  passages: z.array(generatedPassageSchema),
  readingQuestions: z.array(generatedReadingQuestionSchema),
  grammarQuestions: z.array(generatedGrammarQuestionSchema),
})

export type GeneratedPaper = z.infer<typeof generatedPaperSchema>

/** 遮词自检：每道阅读题一个裁决 */
export const maskedCheckVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      questionIndex: z.number().int().describe('题目下标，从 0 计'),
      answeredWithoutWord: choiceLabelSchema.describe('遮住目标词后你选的答案'),
      confident: z
        .boolean()
        .describe('遮住目标词后是否仍能有把握地选出该答案'),
    }),
  ),
})

export type MaskedCheckResult = z.infer<typeof maskedCheckVerdictSchema>

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
