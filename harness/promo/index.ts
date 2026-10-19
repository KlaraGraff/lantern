/**
 * 「场景」—— README 每张样张对应的一套起始状态。
 *
 * 用法是 URL：`?shot=hero`。`scripts/shoot-readme.mjs` 就是这么驱动的。
 * 没带 `?shot=` 时这里全部是惰性的，smoke 测试完全不受影响 —— 这是这个模块
 * 唯一的硬约束。
 *
 * 一个场景只负责两件事：
 *   1. `settings` —— 覆盖哪些设置（语言、阅读主题、字号……）
 *   2. `route`    —— 打开哪个页面
 * 至于「把查词卡点开」这类要等 React 挂载后才能做的事，在 `scenes.ts` 里，
 * 因为那部分需要真的去摸 DOM，和纯数据分开。
 */

import { serializeCardDesignConfig } from "../../src/components/learning-card/config";
import { cardDesignConfigForLevel } from "../../src/components/learning-card/level-presets";
import { recommendedExplanationMode } from "../../src/components/onboarding/explanation-samples";
import type { CefrLevel } from "../../src/components/settings/cefr";
import { PROMO_CARD_CONFIG, PROMO_CARD_CONFIG_CUSTOM } from "./content";

export interface Scene {
  /** 覆盖到 harness 设置上的键值，会盖过 fixture-data 的默认值。 */
  settings?: Record<string, string>;
  /**
   * 初始路由。全应用只有三条：`/`、`/reader/:bookId`、`/book/:id`。
   * 「随记」下面那些不是路由，是 Home 内部状态 —— 用 `libraryFilter` 走。
   */
  route?: string;
  /**
   * Home 左栏要选中哪一行（`all` / `reading` / `finished` / `chats` /
   * `vocab` / `review` / `notes` / `explanations` / `stats`）。
   * 通过真的点那一行来切，不走后门 —— 点得动才算这个界面真的存在。
   */
  libraryFilter?: string;
}

/** 中文样张的共同底子：界面中文、阅读器用 paper 主题、正文字号大一点好截图。 */
const ZH: Record<string, string> = {
  language: "zh",
  theme: "light",
  theme_reader: "paper",
  reader_theme: "paper",
  font_size: "19",
  line_height: "1.7",
  learning_card_config: PROMO_CARD_CONFIG,
};

/**
 * 别名那几张图：读者教过的「那个牧师」是按语义匹配的，要开着向量检索才生效
 * （设置 › AI 配置里那个开关）；不开的话别名表上会挂一条「现在不生效」。
 */
const ZH_ALIASES: Record<string, string> = { ...ZH, ai_vector_retrieval: "true" };

/**
 * 按学习者等级配好的一套设置。
 *
 * 两处都不是手写的，都是端应用自己那个函数的结果：
 *   - 卡片显示哪几块 —— `cardDesignConfigForLevel()`，读者在引导第一步或设置页
 *     选完等级后写进去的就是这一份；
 *   - 讲解语言 —— `recommendedExplanationMode()`，中文界面下 A2 推中文讲解、
 *     C1 推全英文。这一档不是附带的：C1 的卡片本来就该是英文的。
 * 宽度改成「窄」是纯排版选择（卡片宽度本来就是设置项），和等级无关。
 */
const zhAtLevel = (level: CefrLevel): Record<string, string> => {
  const config = cardDesignConfigForLevel(level);
  return {
    ...ZH,
    cefr_level: level,
    explanation_mode: recommendedExplanationMode(level, "zh"),
    learning_card_source: "level",
    learning_card_config: serializeCardDesignConfig({
      ...config,
      cards: { ...config.cards, word: { ...config.cards.word, widthMode: "compact" } },
    }),
  };
};

export const SCENES: Record<string, Scene> = {
  /** 1 阅读器全景：正文 + 查词卡 + AI 侧栏。 */
  hero: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 2 同一个词、同一句话，两个学习者等级各给一张卡（README 里左右并排）。 */
  levelA2: { settings: zhAtLevel("A2"), route: "/reader/pride-and-prejudice" },
  levelC1: { settings: zhAtLevel("C1"), route: "/reader/pride-and-prejudice" },
  /** 3 用户画像：上半段自己写的，下半段系统总结的，其中一张摊开了依据。 */
  profile: { settings: ZH },
  /** 4 带上下文的追问。 */
  context: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 5 回答里的引用可以点回原文。 */
  citations: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 6 单词的掌握度与复习时间线。 */
  vocab: { settings: ZH, libraryFilter: "vocab" },
  /** 7 这本书对你：覆盖率落在尺子上，以及那些还不认识的词。 */
  coverage: { settings: ZH, route: "/book/pride-and-prejudice" },
  /** 8 学习卡片的模块：内置的能排能关，不够用就自己写一个。 */
  cards: { settings: { ...ZH, learning_card_config: PROMO_CARD_CONFIG_CUSTOM } },
  /** 书库全景。不进 README，用来单独检查书架长什么样。 */
  library: { settings: ZH },

  /* ---------------- 宣传片用的场景 ---------------- */

  /** 查一个已经读顺了的词：卡片顶上说「已跳过基础释义」，卡片也真的短了。 */
  memory: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 同一页正文，两个时间点：生词标记按掌握度褪色，读顺了的直接消失。 */
  marksBefore: { settings: ZH, route: "/reader/pride-and-prejudice" },
  marksAfter: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 这本书的人物别名表（AI 索引窗口里的「人物别名」），停在表格那一段。 */
  aliases: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 同一节的开头：「达西」指向两个人，表上先把这件事摊开。 */
  aliasesAmbiguity: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 用中文名问：「『达西』按『Mr. Darcy』找的」+ 换成「Miss Darcy」。 */
  aliasDarcy: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 没认出「那个牧师」：回答下面问一句「对，就是 Mr. Collins 吗」。 */
  aliasPriestLow: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 同一轮，点了「✓ 对」之后：就地变成一行回执。 */
  aliasPriestTaught: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 教过之后再问：「你教过『那个牧师』指的是『Mr. Collins』」。 */
  aliasPriestMedium: { settings: ZH_ALIASES, route: "/reader/pride-and-prejudice" },
  /** 第一次打开一本没读过的书时那张卡（设置 › 阅读里要开着）。 */
  bookOpen: { settings: { ...ZH, book_open_card_enabled: "true" } },
  /** 翻到第二章最后一页：「这一章你查过 N 个词」。 */
  chapterEnd: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 同一行点了「看看」：就地展开，那几个词一个个排出来。 */
  chapterEndOpen: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 学习页顶上的回顾板：几堆词，各带一句来由。 */
  reviewBoard: { settings: ZH, libraryFilter: "vocab" },
  /** 从回顾板的一堆进去翻卡：原句挖空。 */
  flashcard: { settings: ZH, route: "/flashcards?pile=long_unseen" },
  /** 同一张卡，点了「显示答案」。 */
  flashcardAnswer: { settings: ZH, route: "/flashcards?pile=long_unseen" },
};

/** 正文标记那两张图各自在哪个时间点。 */
export const MARK_STAGE: Record<string, "before" | "after"> = {
  marksBefore: "before",
  marksAfter: "after",
};

/**
 * 进场时 URL 里要的场景名，只认这一次。
 *
 * 必须在模块求值时定死：`applySceneRoute()` 之后应用自己还会 navigate，
 * React Router 一路把 query 丢掉，等到 `load` 事件时地址栏上已经没有
 * `?shot=` 了 —— 每次现读的话，场景和 fixture 层会在中途集体失忆。
 */
const SHOT_NAME: string | null = (() => {
  try {
    const name = new URLSearchParams(window.location.search).get("shot");
    return name && name in SCENES ? name : null;
  } catch {
    return null;
  }
})();

/** 当前 URL 要求的场景名；没有就返回 null。 */
export function activeShotName(): string | null {
  return SHOT_NAME;
}

export function activeScene(): Scene | null {
  const name = activeShotName();
  return name ? SCENES[name] : null;
}

/** 是否正在拍样张。数据层用它决定端上哪一套书库。 */
export const isShooting = (): boolean => activeShotName() !== null;
