// Explicit extensions: this module is loaded directly by the node test runner,
// which does not resolve extensionless imports the way Vite does.
import { CEFR_LEVELS, type CefrLevel } from "../settings/cefr.ts";
import {
  LEARNING_CARD_CONFIG_SETTING_KEY,
  buildCardKindConfig,
  createDefaultCardDesignConfig,
} from "./config.ts";
import type { CardDesignConfigV1, LearningModuleId, ModuleDensity } from "./types.ts";

/**
 * Which CEFR level a stored card config was built for, or `manual` once the
 * reader has edited the card themselves. Mirrors `cefr_source`: the level is
 * the input, this records who last had the last word.
 */
export const LEARNING_CARD_SOURCE_SETTING_KEY = "learning_card_source";
export const LEARNING_CARD_SOURCE_LEVEL = "level";
export const LEARNING_CARD_SOURCE_MANUAL = "manual";

/**
 * 等级只换「显示哪几块」，从不换密度、也从不换块数。
 *
 * 这条限制来自 `docs/reviews/learner-perspective-design-review-2026-08-09.md`：
 * §2.1 说单词卡的 `context_meaning` 配成 `detailed` 是双击存在的唯一理由——
 * 单击查免费词典已经回答了「这个词什么意思」，双击问的是「在这一句里是什么
 * 意思」。§2.2 说打断阅读的是「解释太难读」而不是篇幅，处置方向写死了「改写
 * 法，不改篇幅」，并且点名否决了靠少说话取胜。
 *
 * 两条合起来：「初级用户给少几块」——最容易想到的那种分档——恰好是被否决的
 * 那一种。等级能动的只有「换哪几块」。
 *
 * 换的那条轴，从「先读懂这一句」到「把这个词用准」：
 *
 *   全句大意 → 全句脉络 → 单词信息 → 常见释义 → 常用搭配 → 近义词辨析 → 用词取舍
 *
 * A 档卡在句子上，C 档卡在词的分寸上，档位就是这条轴上的一个窗口。
 */
const WORD_MODULES: Record<CefrLevel, LearningModuleId[]> = {
  // 近义词辨析对 A2 是噪音：两个词都不认识的时候，比较它们的差别没有产出。
  A1: ["context_meaning", "sentence_gist", "grammar_role", "word_info", "common_senses"],
  A2: ["context_meaning", "sentence_gist", "grammar_role", "word_info", "common_senses"],
  B1: ["context_meaning", "sentence_gist", "word_info", "common_senses", "collocations"],
  // 出厂默认那一套，一个字不改。
  B2: ["context_meaning", "word_info", "common_senses", "collocations", "synonyms"],
  // 目标语言译文对 C1 是拐杖：他已经读懂了，多出来的那一遍中文没有产出。卡点
  // 变成「作者本可以写 careful，为什么写了 meticulous」。
  C1: ["context_meaning", "why_this_word", "collocations", "usage", "common_senses"],
  C2: ["context_meaning", "why_this_word", "collocations", "usage", "common_senses"],
};

const PHRASE_MODULES: Record<CefrLevel, LearningModuleId[]> = {
  A1: ["context_meaning", "target_translation", "grammar_analysis"],
  A2: ["context_meaning", "target_translation", "grammar_analysis"],
  B1: ["context_meaning", "target_translation", "common_senses"],
  B2: ["context_meaning", "target_translation", "common_senses"],
  C1: ["context_meaning", "idioms", "usage"],
  C2: ["context_meaning", "idioms", "usage"],
};

/**
 * 段落卡低档是四块而不是三块——补了「重难点语法」和「指代关系」。加块不违反
 * §2.2（它禁的是删，不是加），而读不动整段的人正好卡在这两处：句子怎么拆，
 * 以及 it / which 到底指谁。
 */
const PASSAGE_MODULES: Record<CefrLevel, LearningModuleId[]> = {
  A1: ["context_meaning", "target_translation", "grammar_analysis", "references"],
  A2: ["context_meaning", "target_translation", "grammar_analysis", "references"],
  B1: ["context_meaning", "target_translation", "idioms"],
  B2: ["context_meaning", "target_translation", "idioms"],
  C1: ["context_meaning", "tone", "reusable_patterns"],
  C2: ["context_meaning", "tone", "reusable_patterns"],
};

/**
 * 逐模块密度覆盖。`compact` 档下「单词信息」不一定吐出原形，而 A1/A2 撞见
 * `meticulously` 最需要的就是「原形 meticulous」，所以给它单独提一档。这是给
 * 初级读者**多说**，不是少说，不违反 §2.2。
 */
const WORD_DENSITIES: Record<CefrLevel, Partial<Record<LearningModuleId, ModuleDensity>>> = {
  A1: { context_meaning: "detailed", word_info: "standard" },
  A2: { context_meaning: "detailed", word_info: "standard" },
  B1: { context_meaning: "detailed" },
  B2: { context_meaning: "detailed", synonyms: "standard" },
  C1: { context_meaning: "detailed" },
  C2: { context_meaning: "detailed" },
};

/** The card design a reader gets when they have never edited it themselves. */
export function cardDesignConfigForLevel(level: CefrLevel): CardDesignConfigV1 {
  const base = createDefaultCardDesignConfig();
  return {
    ...base,
    cards: {
      word: buildCardKindConfig("word", WORD_MODULES[level], [], {
        defaultDensity: "compact",
        densities: WORD_DENSITIES[level],
      }),
      phrase: buildCardKindConfig("phrase", PHRASE_MODULES[level]),
      passage: buildCardKindConfig("passage", PASSAGE_MODULES[level]),
    },
  };
}

/**
 * Whether changing the level may rewrite the card design.
 *
 * Absent `learning_card_source` plus an already-stored config means the reader
 * built that config by hand before this setting existed — treat it as theirs.
 * Nobody's edits are overwritten and no migration is needed to say so.
 */
export function cardPresetFollowsLevel(settings: Record<string, string | undefined>) {
  const source = settings[LEARNING_CARD_SOURCE_SETTING_KEY];
  if (source === LEARNING_CARD_SOURCE_MANUAL) return false;
  if (source === LEARNING_CARD_SOURCE_LEVEL) return true;
  return !settings[LEARNING_CARD_CONFIG_SETTING_KEY];
}

export function isCefrLevel(value: string | undefined): value is CefrLevel {
  return (CEFR_LEVELS as readonly string[]).includes(value ?? "");
}
