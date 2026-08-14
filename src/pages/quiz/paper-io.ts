/**
 * 词卷试卷行 ↔ 领域模型（Quiz）的序列化契约。
 *
 * 后端把三个 JSON 列（config/words/content）当不透明文本存取（见
 * src-tauri/src/commands/quiz.rs 顶部说明），解析责任全在前端这一层。
 * 词卷页（列表/往卷）和做题/评卷页都经由这里读写，双方不各自解析。
 *
 * 这里用 JSON.parse + 类型断言而不是 zod：这些列只由本前端自己写入
 * （generateQuiz 的产物已过 zod 校验），不是不可信输入。
 */
import type {
  AskThread,
  GrammarFillQuestion,
  Passage,
  Quiz,
  QuizConfig,
  QuizDraft,
  QuizGenerationPlan,
  QuizResult,
  QuizStatus,
  QuizWord,
  ReadingQuestion,
} from '../../quiz/types.ts'

/** get_quiz_paper / list_quiz_papers 返回的行（serde camelCase）。 */
export interface QuizPaperRow {
  id: number
  createdAt: string
  status: string
  configJson: string
  wordsJson: string
  contentJson: string
  resultJson: string | null
  askThreadsJson: string | null
  /** 渐进发卷的生成计划；只在 status = 'generating' 时非空 */
  generationJson: string | null
  /** 未交卷的做题草稿（答案 + 已计用时）；交卷时后端清空 */
  draftJson: string | null
}

/** content_json 的形状：卷面本体（文章 + 两类题）。 */
interface QuizContent {
  passages: Passage[]
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
}

export function rowToQuiz(row: QuizPaperRow): Quiz {
  const content = JSON.parse(row.contentJson) as QuizContent
  return {
    id: row.id,
    createdAt: row.createdAt,
    status: row.status as QuizStatus,
    config: JSON.parse(row.configJson) as QuizConfig,
    words: JSON.parse(row.wordsJson) as QuizWord[],
    passages: content.passages,
    readingQuestions: content.readingQuestions,
    grammarQuestions: content.grammarQuestions,
    result: row.resultJson ? (JSON.parse(row.resultJson) as QuizResult) : undefined,
    askThreads: row.askThreadsJson ? (JSON.parse(row.askThreadsJson) as AskThread[]) : undefined,
    generation: row.generationJson
      ? (JSON.parse(row.generationJson) as QuizGenerationPlan)
      : undefined,
    draft: row.draftJson ? (JSON.parse(row.draftJson) as QuizDraft) : undefined,
  }
}

/** create_quiz_paper / update_quiz_paper_content 的 contentJson 参数。 */
export function quizContentJson(quiz: Quiz): string {
  const content: QuizContent = {
    passages: quiz.passages,
    readingQuestions: quiz.readingQuestions,
    grammarQuestions: quiz.grammarQuestions,
  }
  return JSON.stringify(content)
}
