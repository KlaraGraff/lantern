/**
 * 词卷评卷页查词手势的「作用范围」判定（`docs/impls/quiz-word-lookup.md` §一）。
 *
 * 手势监听挂在 document 上（评卷页的文本散落在文章、题干、选项、讲解、追问抽屉
 * 好几棵子树里，一个根容器圈不住），所以每次手势都要回答两个问题：这一下落在
 * 允许查词的区域里吗？如果要问 AI，出处与上下文取自哪个节点？
 *
 * 判定写成对「祖先链描述」的纯函数，不碰 DOM——`tests/quiz-lookup-scope.test.ts`
 * 里能直接喂数组断言，和 `dictionary-glance.ts` 的 `clickSpendsGlance` 同一套路。
 * DOM 那一步只负责把元素链翻译成描述（`quizLookupPathFrom`）。
 */

/** 圈定可查词区域的标记属性，挂在评卷页的各文本容器上。 */
export const QUIZ_LOOKUP_ATTRIBUTE = "data-quiz-lookup";

/** 追问出处（人类可读）与追问上下文（发给模型的全文），沿用评卷页原有约定。 */
export const ASK_FROM_ATTRIBUTE = "data-ask-from";
export const ASK_CTX_ATTRIBUTE = "data-ask-ctx";

/** 点在这些控件上时手势归控件，不归文本——展开、回到原文、标签页都算。 */
const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,option,[contenteditable='true'],[role='button']";

/** 祖先链上一个节点的全部信息，只有这三件事影响判定。 */
export interface QuizLookupNode {
  /** 这个节点是不是查词区域的边界（挂了 `data-quiz-lookup`）。 */
  surface: boolean;
  /** 这个节点是不是可交互控件。 */
  interactive: boolean;
  /** 追问出处标注，没有就是 null。 */
  askFrom: string | null;
  /** 追问上下文全文，没有就是 null。 */
  askCtx: string | null;
}

export interface QuizLookupTarget {
  askFrom: string | null;
  askCtx: string | null;
}

/** 判定通过后的落点信息，多带一个区域元素——手势要拿它当 range 的根。 */
export interface QuizLookupSurface extends QuizLookupTarget {
  surface: Element;
  /** 最近一层 `lang` 声明，分词按它走（文章标了 `lang="en"`，讲解是中文）。 */
  locale: string | undefined;
}

/**
 * 手势落点是否在查词区域里；在的话顺带给出最近一层的追问出处与上下文。
 *
 * @param path 从落点自身开始、逐级向上的祖先链描述（不含 document）。
 * @returns 不在区域内、或半路撞上可交互控件时返回 null。
 *
 * 「半路撞上控件就退出」优先于「找到区域就通过」：控件通常长在区域里面（题目块里
 * 的「展开」按钮），先看到控件说明这一下是冲控件去的。追问属性取最近的一层——选项
 * 的上下文比整道题的更贴切，而讲解正文没有自己的属性，就继承题目块那一层。
 */
export function quizLookupTarget(path: readonly QuizLookupNode[]): QuizLookupTarget | null {
  let askFrom: string | null = null;
  let askCtx: string | null = null;
  for (const node of path) {
    if (node.interactive) return null;
    if (askFrom === null && node.askFrom !== null) {
      askFrom = node.askFrom;
      // 两个属性成对读取：上下文若缺省，退回同一节点的出处标注之外的调用方兜底。
      askCtx = node.askCtx;
    }
    if (node.surface) return { askFrom, askCtx };
  }
  return null;
}

/** DOM → 描述链。祖先链在文档根处自然终止，不需要额外的停止条件。 */
export function quizLookupPathFrom(target: EventTarget | null): QuizLookupNode[] {
  const node = target as Node | null;
  const start = node?.nodeType === 1 ? (node as Element) : node?.parentElement ?? null;
  const path: QuizLookupNode[] = [];
  for (let element: Element | null = start; element; element = element.parentElement) {
    path.push({
      surface: element.hasAttribute(QUIZ_LOOKUP_ATTRIBUTE),
      interactive: element.matches(INTERACTIVE_SELECTOR),
      askFrom: element.getAttribute(ASK_FROM_ATTRIBUTE),
      askCtx: element.getAttribute(ASK_CTX_ATTRIBUTE),
    });
  }
  return path;
}

/** 落点（元素或文本节点）在不在查词区域里，附带区域元素、追问出处与语言。 */
export function quizLookupSurfaceFor(target: EventTarget | null): QuizLookupSurface | null {
  const found = quizLookupTarget(quizLookupPathFrom(target));
  if (!found) return null;
  const node = target as Node | null;
  const start = node?.nodeType === 1 ? (node as Element) : node?.parentElement ?? null;
  const surface = start?.closest(`[${QUIZ_LOOKUP_ATTRIBUTE}]`);
  if (!surface) return null;
  return {
    ...found,
    surface,
    locale: start?.closest("[lang]")?.getAttribute("lang") || undefined,
  };
}
