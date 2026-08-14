/**
 * 评卷页查词的浮层：单词菜单 / 选段菜单 / 学习卡 / 仅翻译 / 收藏提示。
 * 手势判定在 `useQuizLookup.ts`，这里只管「拿到手势之后画什么、点了做什么」。
 *
 * 菜单本体复用正文那只 `ReaderContextMenu`（纯展示组件，行由调用方给）。词卷没有
 * 「标记」行——高亮是书内实体，落不到一张卷子上（`docs/impls/quiz-word-lookup.md` §一）。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import ReaderContextMenu, { type ReaderMenuAction } from "../../components/ReaderContextMenu";
import {
  detachedInteraction,
  selectedRange,
  wordRangeAtPoint,
} from "../../components/reader-interaction";
import type { PanelSelectionSource } from "../../hooks/usePanelTextSelection";
import LearningCardController from "../../components/learning-card/LearningCardController";
import TranslationPopover from "../../components/TranslationPopover";
import Toast from "../../components/ui/Toast";
import { collectWord } from "../../components/vocab/collect";
import { copyToClipboard } from "../../utils/clipboard";
import { notifyReaders } from "../../utils/notifyReaders";
import { getAllSettings } from "../../hooks/useSettings";
import { useReadingAssistanceSettings } from "../reader/useReadingAssistanceSettings";
import { useQuizLookup, type QuizLookupGesture } from "./useQuizLookup";
import type { AskTarget } from "./useAskThread";

/** 词卷收藏在生词本里的来源标识，与后端 `add_vocab_word` 的 `source` 对齐。 */
const QUIZ_VOCAB_SOURCE = "quiz";

const WORD_MENU_ROWS: ReaderMenuAction[] = ["primary", "ask-ai", "save", "translate", "copy", "speak"];
const SELECTION_MENU_ROWS: ReaderMenuAction[] = ["ask-ai", "translate", "copy", "speak"];

export default function QuizLookupLayer(props: {
  /** 只在评卷态开。 */
  enabled: boolean;
  /** 收藏进生词本时记的来源，如「8/14 今日词卷」。 */
  sourceLabel: string;
  /** 问 AI：一律路由到评卷页既有的追问抽屉。 */
  onAsk: (target: AskTarget) => void;
}) {
  const { enabled, sourceLabel, onAsk } = props;
  const { t } = useTranslation();
  const {
    adoptReadingAssistanceSettings,
    doubleClickQuickLookupRef,
    learningCardConfig,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
  } = useReadingAssistanceSettings();

  // 这个 hook 自己只订阅「设置变了」的广播，首帧的值要调用方喂一次——正文由
  // useReaderSettingsSync 代劳，评卷页没有那一层，就地读一次全量设置。
  useEffect(() => {
    let disposed = false;
    getAllSettings()
      .then((settings) => {
        if (!disposed) adoptReadingAssistanceSettings(settings);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [adoptReadingAssistanceSettings]);

  const { menu, card, closeMenu, closeCard, openCard, openMenu } = useQuizLookup({
    enabled,
    tripleClickScopeRef,
    tripleClickQuickSelectRef,
    doubleClickQuickLookupRef,
  });

  /**
   * 卡内二次查词后压住卡内划选的时刻。双击选中一个词的同时也算一次划选，
   * 不压一下就会在刚换出来的卡上再开一次菜单（正文同一处理，见 Reader.tsx
   * 的 `panelLookupSuppressUntilRef`）。
   */
  const cardSuppressUntil = useRef(0);
  const cardSelectionTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (cardSelectionTimer.current !== null) window.clearTimeout(cardSelectionTimer.current);
  }, []);

  /**
   * 学习卡内部的双击查词。卡不叠卡——评卷页只留一张，新词直接替换：
   * 卷面上随时能再点一次，没必要在一张浮层上堆栈。
   */
  const lookupInCard = useCallback((event: ReactMouseEvent<HTMLElement>, origin: QuizLookupGesture) => {
    if (cardSelectionTimer.current !== null) {
      window.clearTimeout(cardSelectionTimer.current);
      cardSelectionTimer.current = null;
    }
    const interaction = detachedInteraction(
      wordRangeAtPoint(document, event.clientX, event.clientY),
      event.currentTarget,
      "word-quick-lookup",
    );
    if (!interaction) return;
    event.preventDefault();
    cardSuppressUntil.current = Date.now() + 400;
    // 出处沿用这张卡的：追问的还是卷面上那道题。
    openCard({ interaction, askFrom: origin.askFrom, askCtx: origin.askCtx });
  }, [openCard]);

  /** 学习卡内部的划选 → 选段菜单。防抖与正文 `openPanelSelectionMenu` 同值。 */
  const selectInCard = useCallback((source: PanelSelectionSource, origin: QuizLookupGesture) => {
    if (Date.now() < cardSuppressUntil.current) return;
    const root = source.currentTarget;
    if (cardSelectionTimer.current !== null) window.clearTimeout(cardSelectionTimer.current);
    cardSelectionTimer.current = window.setTimeout(() => {
      cardSelectionTimer.current = null;
      const interaction = detachedInteraction(selectedRange(document), root, "selection-menu");
      if (!interaction) return;
      openMenu({ interaction, askFrom: origin.askFrom, askCtx: origin.askCtx });
    }, 220);
  }, [openMenu]);

  const [translation, setTranslation] = useState<QuizLookupGesture | null>(null);
  const [savedWord, setSavedWord] = useState<string | null>(null);
  /** 菜单里的「收藏」是否该显示成已收藏态（全表口径，不分书）。 */
  const [alreadySaved, setAlreadySaved] = useState(false);

  const askFor = useCallback((gesture: QuizLookupGesture) => {
    onAsk({
      quote: gesture.interaction.text,
      quoteFrom: gesture.askFrom || t("quizLookup.askFromPaper"),
      context: gesture.askCtx || gesture.interaction.context || gesture.interaction.text,
    });
  }, [onAsk, t]);

  const menuWord = menu?.interaction.kind === "word" ? menu.interaction.text : null;
  useEffect(() => {
    setAlreadySaved(false);
    if (!menuWord) return;
    let disposed = false;
    invoke<boolean>("check_vocab_exists_global", { word: menuWord })
      .then((exists) => {
        if (!disposed) setAlreadySaved(Boolean(exists));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [menuWord]);

  useEffect(() => {
    if (!savedWord) return;
    const timer = window.setTimeout(() => setSavedWord(null), 2600);
    return () => window.clearTimeout(timer);
  }, [savedWord]);

  const save = useCallback(async (gesture: QuizLookupGesture) => {
    const word = gesture.interaction.text;
    closeMenu();
    try {
      await collectWord({
        // 词卷收藏不属于任何一本书：去重按全表走，也不会随删书被级联掉。
        bookId: null,
        word,
        contextSentence: gesture.interaction.context || null,
        cfi: null,
        source: QUIZ_VOCAB_SOURCE,
        sourceLabel,
      });
      // 没有书就没有哪扇阅读器窗口需要重画标记，只广播给本窗口的生词本列表。
      notifyReaders("vocab-changed", { bookId: null });
      setSavedWord(word);
    } catch (error) {
      console.error("Failed to save quiz vocab word:", error);
    }
  }, [closeMenu, sourceLabel]);

  if (!enabled) return null;

  return (
    <>
      {menu && (
        <ReaderContextMenu
          key={`${menu.interaction.trigger}:${menu.interaction.text}`}
          anchorRect={menu.interaction.anchorRect}
          text={menu.interaction.text}
          kind={menu.interaction.kind}
          order={menu.interaction.kind === "word" && menu.interaction.trigger === "word-menu"
            ? WORD_MENU_ROWS
            : SELECTION_MENU_ROWS}
          saved={alreadySaved}
          // 评卷页没有装正文那套键盘绑定，印出来的快捷键会是按不出效果的说明。
          showShortcuts={false}
          onClose={closeMenu}
          onLookup={() => openCard(menu)}
          onExplain={() => openCard(menu)}
          onQuote={() => {
            closeMenu();
            askFor(menu);
          }}
          onSave={() => void save(menu)}
          onTranslate={() => {
            closeMenu();
            setTranslation(menu);
          }}
          onCopy={() => {
            closeMenu();
            void copyToClipboard(menu.interaction.text);
          }}
        />
      )}

      {card && (
        <LearningCardController
          key={card.interaction.text}
          interaction={card.interaction}
          config={learningCardConfig}
          vocabSource={QUIZ_VOCAB_SOURCE}
          vocabSourceLabel={sourceLabel}
          onLookupWord={(event) => lookupInCard(event, card)}
          onSelectText={(source) => selectInCard(source, card)}
          onClose={closeCard}
          onAskAi={(quote) => askFor({ ...card, interaction: { ...card.interaction, text: quote } })}
        />
      )}

      {translation && (
        <TranslationPopover
          x={translation.interaction.anchorRect.right}
          y={translation.interaction.anchorRect.top}
          text={translation.interaction.text}
          context={translation.interaction.context}
          onClose={() => setTranslation(null)}
          onAskFollowUp={(quote) => {
            askFor({ ...translation, interaction: { ...translation.interaction, text: quote } });
            setTranslation(null);
          }}
        />
      )}

      {savedWord && <Toast>{t("quizLookup.savedToast", { word: savedWord, source: sourceLabel })}</Toast>}
    </>
  );
}
