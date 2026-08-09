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
  font_size: "19",
  line_height: "1.7",
};

export const SCENES: Record<string, Scene> = {
  /** 1 阅读器全景：正文 + 查词卡 + AI 侧栏。 */
  hero: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 2 同一个词，两个 CEFR 等级的解释。 */
  levels: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 3 带上下文的追问。 */
  context: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 4 回答里的引用可以点回原文。 */
  citations: { settings: ZH, route: "/reader/pride-and-prejudice" },
  /** 5 单词的掌握度与复习时间线。 */
  vocab: { settings: ZH, libraryFilter: "vocab" },
  /** 6 这本书的词汇难度。 */
  difficulty: { settings: ZH, route: "/book/pride-and-prejudice" },
  /** 7 学习卡片的模块开关。 */
  cards: { settings: ZH },
  /** 8 MCP：把书库交给外部 AI 客户端。 */
  mcp: { settings: { ...ZH, mcp_enabled: "true" } },

  /** 书库全景。不进 README，用来单独检查书架长什么样。 */
  library: { settings: ZH },
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
