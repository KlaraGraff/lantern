/**
 * 生词本一行的「来源」怎么写。
 *
 * 绝大多数行来自一本书，来源就是书名。词卷收藏的行没有书（`book_id` 为
 * NULL），也没有 CFI，所以既不能印书名，也不能给「定位原文」——那是书才有的
 * 能力。这里把判定与文案集中一处，免得每个生词本界面各写一遍
 * `book_title || 未知书籍`，把词卷的词印成「未知书籍」。
 *
 * 见 `docs/impls/quiz-word-lookup.md` §五。
 */

/** 按书分组的视图里，无书行归的那一组。真书的 id 是 UUID，撞不上。 */
export const QUIZ_VOCAB_GROUP_ID = "__quiz__";

export interface VocabSourceRow {
  book_id: string | null;
  book_title?: string | null;
  source_label?: string | null;
}

/** 这一行不属于任何一本书——今天只有词卷会这样。 */
export function isBooklessVocabRow(row: VocabSourceRow): boolean {
  return !row.book_id;
}

/** 按书分组/按书筛选时这一行归到哪个键下。 */
export function vocabGroupId(row: VocabSourceRow): string {
  return row.book_id || QUIZ_VOCAB_GROUP_ID;
}

/** i18next 的 `t`，只用到「取 key + 插值」这一点点。 */
type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * 来源那一行印什么：书名，或「词卷 · 8/14 今日词卷」。
 *
 * 词卷行连卷名都没有（历史行、或标签没存下）时只印「词卷」——不回退到
 * 「未知书籍」，它本来就不出自任何一本书。
 */
export function vocabSourceText(row: VocabSourceRow, t: Translate, unknownBookKey = "common.unknownBook"): string {
  if (!isBooklessVocabRow(row)) return row.book_title?.trim() || t(unknownBookKey);
  const label = row.source_label?.trim();
  return label ? t("quizLookup.vocabSource", { label }) : t("quizLookup.vocabGroup");
}

/** 按书分组的组名 / 书籍筛选药丸上的名字，同一套口径。 */
export function vocabGroupLabel(row: VocabSourceRow, t: Translate, unknownBookKey = "common.unknownBook"): string {
  return isBooklessVocabRow(row) ? t("quizLookup.vocabGroup") : row.book_title?.trim() || t(unknownBookKey);
}

/**
 * 合并视图里一个「来源」（`MergedVocabEntry.books` 的元素）印什么。词卷伪书
 * 印「词卷 · 卷名」或「词卷」，绝不落回「未知书籍」——删除确认弹窗把它列进
 * 「它在 A 和 B 各有一条记录」时，读者必须认得出第二条是什么。
 */
export function mergedVocabBookLabel(
  book: { quiz: boolean; title: string | null; sourceLabel: string | null },
  t: Translate,
  unknownBookKey = "common.unknownBook",
): string {
  if (!book.quiz) return book.title?.trim() || t(unknownBookKey);
  const label = book.sourceLabel?.trim();
  return label ? t("quizLookup.vocabSource", { label }) : t("quizLookup.vocabGroup");
}
