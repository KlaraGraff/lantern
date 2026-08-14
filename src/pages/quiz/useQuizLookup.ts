/**
 * 评卷页的查词手势（`docs/impls/quiz-word-lookup.md` §一）。
 *
 * 手势判定完全接正文那条管线——`reader-interaction.ts` 里的 `wordRangeAtPoint` /
 * `tripleClickRangeAtPoint` 是纯 DOM 函数，`detachedInteraction()` 负责产出一条
 * 没有 CFI、不绑书的 `ReaderInteraction`（AI 面板气泡早就这么用了，见
 * `usePanelTextSelection.ts` 与 `Reader.tsx` 的 `lookupWordInPanel`）。这里是第三
 * 个接入方，不另造一套手势系统。
 *
 * 与正文的两处差别：
 * - 作用范围靠 `data-quiz-lookup` 圈定（评卷页文本分散在文章、题块、追问抽屉几棵
 *   子树里），判定见 `lookup-scope.ts`；
 * - 单击/双击一律不改写文档选区。正文要靠选区回答「标记哪一段」，评卷页没有标记，
 *   画上选区只会在手机上留下两只拖拽把手。三击是唯一例外——选出一句话正是它的目的。
 */
import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import {
  detachedInteraction,
  replaceDocumentSelection,
  selectedRange,
  tripleClickRangeAtPoint,
  wordRangeAtPoint,
  type ReaderInteraction,
  type TripleClickScope,
} from "../../components/reader-interaction";
import { clickCountGraceMs } from "../reader/click-grace";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { quizLookupSurfaceFor } from "./lookup-scope";

/** 一次手势的结果：交互本身 + 这块文字的追问出处（问 AI 用）。 */
export interface QuizLookupGesture {
  interaction: ReaderInteraction;
  askFrom: string | null;
  askCtx: string | null;
}

export interface UseQuizLookupResult {
  /** 当前该显示的菜单（单词菜单或选段菜单），没有就是 null。 */
  menu: QuizLookupGesture | null;
  /** 当前该显示的学习卡。 */
  card: QuizLookupGesture | null;
  closeMenu: () => void;
  closeCard: () => void;
  /** 菜单里的「解释」走这里——同一条交互换成学习卡。 */
  openCard: (gesture: QuizLookupGesture) => void;
  /** 卡内二次划选那类「不是文档手势」的入口，由调用方自己产出交互。 */
  openMenu: (gesture: QuizLookupGesture) => void;
}

/** 拖选后等选区停稳的时间，与 `usePanelTextSelection` 同一量级。 */
const SELECTION_SETTLE_MS = 120;
/** 鼠标松开后开菜单的防抖，与 `Reader.tsx` 的 `openPanelSelectionMenu` 一致。 */
const SELECTION_MENU_DELAY_MS = 220;
/**
 * 自己改写选区后要压住选区监听多久。三击把句子选上会触发 `selectionchange`，
 * 放任它跑就会在刚开的菜单上再开一次。
 */
const SELECTION_SUPPRESS_MS = 400;

export function useQuizLookup(opts: {
  /** 只在评卷态开（做题中不查词）。 */
  enabled: boolean;
  tripleClickScopeRef: MutableRefObject<TripleClickScope>;
  tripleClickQuickSelectRef: MutableRefObject<boolean>;
  doubleClickQuickLookupRef: MutableRefObject<boolean>;
}): UseQuizLookupResult {
  const { enabled, tripleClickScopeRef, tripleClickQuickSelectRef, doubleClickQuickLookupRef } = opts;
  const coarsePointer = useCoarsePointer();
  const [menu, setMenu] = useState<QuizLookupGesture | null>(null);
  const [card, setCard] = useState<QuizLookupGesture | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeCard = useCallback(() => setCard(null), []);
  const openCard = useCallback((gesture: QuizLookupGesture) => {
    setMenu(null);
    setCard(gesture);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cardTimer: number | null = null;
    let selectionTimer: number | null = null;
    let suppressSelectionUntil = 0;
    /** 按下的指针数，与 `usePanelTextSelection` 同一套：第二根手指落下不算第一根抬起。 */
    let pointersDown = 0;
    /** 指针还按着时来过 `selectionchange`——长按选词后抬手不会再有一次变化。 */
    let changedWhileDown = false;

    const cancelCard = () => {
      if (cardTimer === null) return;
      window.clearTimeout(cardTimer);
      cardTimer = null;
    };
    const cancelSelection = () => {
      if (selectionTimer === null) return;
      window.clearTimeout(selectionTimer);
      selectionTimer = null;
    };

    const openSelectionMenu = (delay: number) => {
      cancelSelection();
      selectionTimer = window.setTimeout(() => {
        selectionTimer = null;
        if (Date.now() < suppressSelectionUntil) return;
        const range = selectedRange(document);
        if (!range) return;
        const found = quizLookupSurfaceFor(range.commonAncestorContainer);
        if (!found) return;
        const interaction = detachedInteraction(range, found.surface, "selection-menu", found.locale);
        if (!interaction) return;
        setMenu({ interaction, askFrom: found.askFrom, askCtx: found.askCtx });
      }, delay);
    };

    const onClick = (event: MouseEvent) => {
      if (
        event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
      ) return;
      // 有活着的选区就是拖选/三击的收尾，那条路自己会开选段菜单。
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) return;
      const found = quizLookupSurfaceFor(event.target);
      if (!found) return;
      const range = wordRangeAtPoint(document, event.clientX, event.clientY, found.locale);
      if (!range) return;
      const interaction = detachedInteraction(range, found.surface, "word-menu", found.locale);
      if (!interaction) return;
      // 单击落在词上一律按「单词」走，与正文 `interactionForRange(range, false)`
      // 同口径：菜单顶上的词典卡片是这条路的主角。
      setMenu({
        interaction: { ...interaction, kind: "word" },
        askFrom: found.askFrom,
        askCtx: found.askCtx,
      });
    };

    const onDoubleClick = (event: MouseEvent) => {
      cancelSelection();
      if (!doubleClickQuickLookupRef.current) return;
      const found = quizLookupSurfaceFor(event.target);
      if (!found) return;
      const range = wordRangeAtPoint(document, event.clientX, event.clientY, found.locale);
      if (!range) return;
      const interaction = detachedInteraction(range, found.surface, "word-quick-lookup", found.locale);
      if (!interaction) return;
      event.preventDefault();
      setMenu(null);
      // 延后一拍：三击是「双击 + 第三下」，立刻开卡就会在去选句子的路上先弹一张卡。
      cancelCard();
      cardTimer = window.setTimeout(() => {
        cardTimer = null;
        setCard({ interaction, askFrom: found.askFrom, askCtx: found.askCtx });
      }, clickCountGraceMs(2, tripleClickQuickSelectRef.current));
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.detail !== 3) return;
      // 第二下排的那张卡先撤掉，哪怕这一下最后没选出句子。
      cancelCard();
      cancelSelection();
      if (!tripleClickQuickSelectRef.current) return;
      const found = quizLookupSurfaceFor(event.target);
      if (!found) return;
      const range = tripleClickRangeAtPoint(
        document,
        event.clientX,
        event.clientY,
        tripleClickScopeRef.current,
        found.locale,
      );
      if (!range || !range.toString().trim()) return;
      const interaction = detachedInteraction(range, found.surface, "selection-menu", found.locale);
      if (!interaction) return;
      // 阻止浏览器自己选整段：等到 click 再拦已经晚了，读者会先看见整段被选中。
      event.preventDefault();
      suppressSelectionUntil = Date.now() + SELECTION_SUPPRESS_MS;
      replaceDocumentSelection(document, range);
      setMenu({ interaction, askFrom: found.askFrom, askCtx: found.askCtx });
    };

    const onMouseUp = () => {
      if (coarsePointer) return;
      openSelectionMenu(SELECTION_MENU_DELAY_MS);
    };

    const onSelectionChange = () => {
      if (!coarsePointer) return;
      cancelSelection();
      if (pointersDown > 0) {
        changedWhileDown = true;
        return;
      }
      openSelectionMenu(SELECTION_SETTLE_MS);
    };

    const onPointerDown = () => {
      pointersDown += 1;
      cancelSelection();
    };
    const onPointerEnd = () => {
      pointersDown = Math.max(0, pointersDown - 1);
      if (pointersDown > 0 || !changedWhileDown) return;
      changedWhileDown = false;
      openSelectionMenu(SELECTION_SETTLE_MS);
    };
    const onBlur = () => {
      pointersDown = 0;
      changedWhileDown = false;
      cancelSelection();
      cancelCard();
    };

    document.addEventListener("click", onClick);
    document.addEventListener("dblclick", onDoubleClick);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    // 捕获阶段：组件自己吞掉 pointer 事件时，计数不能就此卡在零以上。
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelCard();
      cancelSelection();
      document.removeEventListener("click", onClick);
      document.removeEventListener("dblclick", onDoubleClick);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerEnd, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [coarsePointer, doubleClickQuickLookupRef, enabled, tripleClickQuickSelectRef, tripleClickScopeRef]);

  useEffect(() => {
    if (enabled) return;
    setMenu(null);
    setCard(null);
  }, [enabled]);

  return { menu, card, closeMenu, closeCard, openCard, openMenu: setMenu };
}
