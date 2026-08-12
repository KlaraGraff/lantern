import type {
  AiProfile,
  GrammarFillQuestion,
  Passage,
  Quiz,
  QuizConfig,
  QuizWord,
  ReadingQuestion,
} from '../types'
import { callStructured } from './client'
import { buildGeneratePrompt, buildMaskedCheckPrompt } from './prompts'
import { generatedPaperSchema, maskedCheckVerdictSchema } from './schemas'
import { splitWords } from './split'

/** 生成进度，对应加载页的四步 */
export type GenerateStep =
  | 'splitting' // 拆分词组
  | 'writing' // 撰写文章与题目
  | 'maskedCheck' // 遮词自检
  | 'regenerating' // 重出未过自检的题
  | 'done'

export type ProgressFn = (step: GenerateStep) => void

let idCounter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idCounter}`

/**
 * 主流程：拆词 → 每组词一次调用（一篇文章+它的题）并发生成 → 遮词自检 → 重出不合格题（一轮）。
 * 按组分次调用而不是整卷一次：词多时单次输出会顶到 max_tokens 被截断，且分次可并发。
 */
export async function generateQuiz(opts: {
  profile: AiProfile
  words: QuizWord[]
  config: QuizConfig
  onProgress?: ProgressFn
}): Promise<Quiz> {
  const { profile, words, config } = opts
  const progress = opts.onProgress ?? (() => {})

  progress('splitting')
  const groups = splitWords(words)

  progress('writing')
  const papers = await Promise.all(
    groups.map((group) =>
      callStructured({
        profile,
        prompt: buildGeneratePrompt({
          words: group.map((w) => w.word),
          difficulty: config.difficulty,
          types: config.types,
        }),
        schema: generatedPaperSchema,
        maxTokens: 16000,
      }),
    ),
  )

  const passages: Passage[] = []
  let readingQuestions: ReadingQuestion[] = []
  const grammarQuestions: GrammarFillQuestion[] = []

  for (const paper of papers) {
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
    for (const q of paper.readingQuestions) {
      readingQuestions.push({
        id: nextId('rq'),
        type: 'reading',
        passageId: passage.id,
        targetWord: q.targetWord,
        stem: q.stem,
        stemTranslation: q.stemTranslation,
        howToSolve: q.howToSolve,
        wordNote: q.wordNote,
        options: q.options,
        answer: q.answer,
        source: { passageId: passage.id, paragraph: q.sourceParagraph, quote: q.sourceQuote },
      })
    }
    for (const q of paper.grammarQuestions) {
      grammarQuestions.push({
        id: nextId('gq'),
        type: 'grammarFill',
        targetWord: q.targetWord,
        sentence: q.sentence,
        sentenceTranslation: q.sentenceTranslation,
        hint: q.hint,
        answer: q.answer,
        grammarPoints: q.grammarPoints,
        reasoning: q.reasoning,
        wrongForms: q.wrongForms,
        wordMeaning: q.wordMeaning,
      })
    }
  }

  // 覆盖校验：没被任何题考到的词从本卷词表剔除——否则池中的重现词会被
  // 误当作「已重现但没答错」，永远滞留在到期队列里，每张新卷都白白多背一次成本
  const covered = new Set(
    [...readingQuestions, ...grammarQuestions].map((q) => q.targetWord.toLowerCase()),
  )
  const coveredWords = words.filter((w) => covered.has(w.word.toLowerCase()))

  if (config.maskedCheck && readingQuestions.length > 0) {
    progress('maskedCheck')
    readingQuestions = await runMaskedCheck({
      profile,
      passages,
      questions: readingQuestions,
      config,
      progress,
    })
  }

  progress('done')
  return {
    createdAt: new Date().toISOString(),
    config,
    words: coveredWords,
    passages,
    readingQuestions,
    grammarQuestions,
    status: 'ready',
  }
}

/**
 * 遮词自检：遮住目标词让模型重做。
 * 模型仍能有把握答对（confident 且答案一致）的题 = 没考到词 → 重出一轮。
 * 重出后不再复检（一轮止损，避免无限循环烧钱）；重出失败则保留原题。
 */
async function runMaskedCheck(opts: {
  profile: AiProfile
  passages: Passage[]
  questions: ReadingQuestion[]
  config: QuizConfig
  progress: ProgressFn
}): Promise<ReadingQuestion[]> {
  const { profile, passages, questions, config, progress } = opts
  const byId = new Map(passages.map((p) => [p.id, p]))
  const items = questions.map((q) => ({ passage: byId.get(q.passageId)!, question: q }))

  const check = await callStructured({
    profile,
    prompt: buildMaskedCheckPrompt(items),
    schema: maskedCheckVerdictSchema,
    maxTokens: 8000,
  })

  const failedIdx = new Set(
    check.verdicts
      .filter((v) => v.confident && questions[v.questionIndex]?.answer === v.answeredWithoutWord)
      .map((v) => v.questionIndex),
  )
  if (failedIdx.size === 0) return questions

  progress('regenerating')
  const failed = [...failedIdx].map((i) => questions[i])
  try {
    const redo = await callStructured({
      profile,
      prompt: buildGeneratePrompt({
        words: [],
        difficulty: config.difficulty,
        types: config.types,
        regenerate: { passages, failedQuestions: failed },
      }),
      schema: generatedPaperSchema,
      maxTokens: 16000,
    })
    const replacements = redo.readingQuestions
    return questions.map((q, i) => {
      if (!failedIdx.has(i)) return q
      const order = [...failedIdx].indexOf(i)
      const r = replacements[order]
      if (!r) return q
      const passage = passages[r.passageIndex] ?? byId.get(q.passageId)!
      return {
        ...q,
        stem: r.stem,
        stemTranslation: r.stemTranslation,
        howToSolve: r.howToSolve,
        wordNote: r.wordNote,
        options: r.options,
        answer: r.answer,
        source: { passageId: passage.id, paragraph: r.sourceParagraph, quote: r.sourceQuote },
      }
    })
  } catch {
    // 重出失败不阻塞整卷：保留原题，宁可这道题考点弱一点
    return questions
  }
}
