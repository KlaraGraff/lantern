import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { readerMenuRows } from "../../components/reader-bindings";
import type { ReaderInteraction } from "../../components/reader-interaction";
import type { CardDesignConfigV1 } from "../../components/learning-card";
import { readerMenuAction } from "./menu-actions";

/** Cards stay open until dismissed; past this many the oldest one gives way. */
const MAX_LEARNING_CARDS = 5;

interface LearningCardsOptions {
  learningCardConfig: CardDesignConfigV1;
  /** Text books have no range store, so their menus can't offer marking. */
  supportsManualAnnotations: boolean;
  onToast: (message: string) => void;
}

/**
 * The stack of open learning cards, and the question every gesture that might
 * open a menu instead has to ask first: would that menu draw anything?
 *
 * Both answers come out of the same card-design config, which is why they live
 * together — a kind whose modules are all disabled opens no card, and a kind
 * whose menu rows all resolve away opens no menu.
 */
export function useLearningCards({
  learningCardConfig,
  supportsManualAnnotations,
  onToast,
}: LearningCardsOptions) {
  const { t } = useTranslation();
  const [learningCards, setLearningCards] = useState<Array<{ id: string; interaction: ReaderInteraction }>>([]);
  const [topLearningCardId, setTopLearningCardId] = useState<string | null>(null);

  const openLearningCard = useCallback((interaction: ReaderInteraction) => {
    const hasEnabledModule = learningCardConfig.cards[interaction.kind].modules
      .some((module) => module.enabled);
    if (!hasEnabledModule) {
      onToast(t("learningCard.allModulesDisabled"));
      return;
    }
    // Cards stay put once opened, so raising happens by stacking order rather
    // than by reordering them — moving a card's node would drop the pointer
    // capture that a drag starting on that same click depends on.
    const id = `${interaction.kind}:${interaction.location}:${interaction.text}`;
    setLearningCards((current) => (
      current.some((card) => card.id === id)
        ? current
        : [...current, { id, interaction }].slice(-MAX_LEARNING_CARDS)
    ));
    setTopLearningCardId(id);
  }, [learningCardConfig, onToast, t]);

  const closeLearningCard = useCallback((id: string) => {
    setLearningCards((current) => current.filter((item) => item.id !== id));
  }, []);

  // What the selection menu would actually draw for this interaction. An empty
  // `order` is not the same question: the menu injects and drops rows of its own,
  // so only the rendered count says whether opening it shows the reader anything.
  const selectionMenuRowCount = useCallback((interaction: ReaderInteraction) => {
    const enabled = learningCardConfig.selectionMenus[interaction.kind].filter((item) => item.enabled);
    return readerMenuRows(
      enabled.map((item) => readerMenuAction(item.id)),
      {
        canToggleMark: Boolean(supportsManualAnnotations && interaction.location),
        customActionIds: enabled
          .filter((item) => item.id.startsWith("custom_") && item.name && item.prompt)
          .map((item) => item.id),
      },
    ).length;
  }, [learningCardConfig.selectionMenus, supportsManualAnnotations]);

  return {
    learningCards,
    topLearningCardId,
    setTopLearningCardId,
    openLearningCard,
    closeLearningCard,
    selectionMenuRowCount,
  };
}
