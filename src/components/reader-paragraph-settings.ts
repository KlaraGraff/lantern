import type { ParagraphSpacing } from "./ReaderSettings";

/**
 * 首行缩进和段间距是同一个问题的两种排版传统：都在回答「一段结束了没有」。
 * 书籍排版里两者从不并用——缩进的书段间不留空，留空的书首行不缩进。同时开
 * 起来读着像每段都被推开一次，是典型的业余排版特征。
 *
 * 所以这两个控件互斥，而且是「静默改对方」而不是「禁用对方」：禁用会让用户
 * 以为坏了，改掉再配一句说明，用户能立刻看懂发生了什么。
 *
 * `original`（跟随出版方）是中立态，不参与互斥——它表示「我没表态」，不是
 * 「我要段间距」。同理 `none` 也不与缩进冲突：缩进 + 零段距正是缩进流派本来
 * 的样子。冲突的只有 compact / comfortable / loose 这三个明确要空隙的值。
 */
export function paragraphSpacingConflictsWithIndent(spacing: ParagraphSpacing): boolean {
  return spacing === "compact" || spacing === "comfortable" || spacing === "loose";
}

export interface ParagraphStyleState {
  firstLineIndent: boolean;
  paragraphSpacing: ParagraphSpacing;
}

/** 开缩进时把冲突的段间距压回 `none`；关缩进时不动段间距。 */
export function withFirstLineIndent(
  firstLineIndent: boolean,
  current: ParagraphStyleState,
): ParagraphStyleState {
  if (!firstLineIndent) return { ...current, firstLineIndent };
  return {
    firstLineIndent: true,
    paragraphSpacing: paragraphSpacingConflictsWithIndent(current.paragraphSpacing)
      ? "none"
      : current.paragraphSpacing,
  };
}

/** 选了明确要空隙的段间距就关掉缩进；选 `original` / `none` 不动缩进。 */
export function withParagraphSpacing(
  paragraphSpacing: ParagraphSpacing,
  current: ParagraphStyleState,
): ParagraphStyleState {
  return {
    paragraphSpacing,
    firstLineIndent: paragraphSpacingConflictsWithIndent(paragraphSpacing)
      ? false
      : current.firstLineIndent,
  };
}

/**
 * 两者当前处于互斥关系中的哪一边——界面据此决定提示哪一句。
 *
 * 两句提示说的都是「另一个已经被改掉了」，所以只有真的改掉了才能返回对应的
 * 那一边。开着缩进、但段间距停在中性值（`original` 跟随出版方）时没有发生
 * 任何互斥，此时若还报 `indent`，界面就会在「跟随出版方」那一行的下面写着
 * 「段间距已设为无」——说了一件没发生的事。
 */
export function paragraphStyleMode(
  state: ParagraphStyleState,
): "indent" | "spacing" | "neutral" {
  if (state.firstLineIndent && state.paragraphSpacing === "none") return "indent";
  if (!state.firstLineIndent && paragraphSpacingConflictsWithIndent(state.paragraphSpacing)) {
    return "spacing";
  }
  return "neutral";
}

/**
 * 行距的「自动」默认值按脚本分。
 *
 * 中文方块字满行密度高、没有词间空隙，行与行之间需要更多空气才不糊成一片；
 * 西文有升部降部和词距，1.8 反而把一段拆得散。这两个数字来自实际排版惯例，
 * 不是从旧的单一默认值 1.8 平移过来的。
 *
 * 用户一旦手动调过，`lineSpacing` 就是一个具体数字，脚本不再参与。
 */
export const AUTO_LINE_SPACING_LATIN = 1.6;
export const AUTO_LINE_SPACING_CJK = 1.8;

/** 「自动」在滑块/数字框上的落点——需要一个具体位置时用它，取两者中间。 */
export const AUTO_LINE_SPACING_THUMB = 1.7;

export type LineSpacing = number | "auto";

export function isAutoLineSpacing(value: LineSpacing): value is "auto" {
  return value === "auto";
}

/**
 * 解析成一个数字。EPUB 侧不走这里——那边用 `:lang()` 选择器让浏览器逐元素
 * 判断，英文书里嵌的中文引文也能拿到中文行距。这个函数是给拿不到 DOM 语言
 * 标记的地方用的（.txt 阅读器按段落自己判中西文）。
 */
export function resolveLineSpacing(value: LineSpacing, isCjk: boolean): number {
  if (value !== "auto") return value;
  return isCjk ? AUTO_LINE_SPACING_CJK : AUTO_LINE_SPACING_LATIN;
}

/** 从 `settings` 表的字符串还原。空/缺失/无法解析都落回 `"auto"`。 */
export function parseLineSpacing(raw: string | undefined | null): LineSpacing {
  if (!raw || raw === "auto") return "auto";
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : "auto";
}
