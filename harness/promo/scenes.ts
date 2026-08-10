/**
 * 场景的「动作」部分 —— 需要摸到 DOM 才能做的事。
 *
 * 数据在 `index.ts`（设置、路由）和 `content.ts`（AI 产出），这里只管两件：
 *   1. 应用挂载**之前**把地址栏改成场景要的路由，这样 BrowserRouter 一开局
 *      就在对的页面，不会先闪一下书库再跳走；
 *   2. 应用挂载**之后**去点该点的东西，然后在 <html> 上打一个
 *      `data-shot-ready`，告诉截图脚本可以按快门了。
 *
 * 为什么用「点」而不是直接改 state：点得动才说明这个界面真的存在。样张的全部
 * 价值就在这一句上 —— 一旦开始走后门，图就又开始撒谎了。
 *
 * 唯一一处「深入」是正文里的双击：EPUB 正文在 foliate 的 iframe 里，而
 * `foliate-paginator` 的 shadow root 是关闭的。拿 document 走的是 foliate 自己
 * 的公开 API（`renderer.getContents()`），和 `src/pages/reader/` 里取正文
 * document 的那一条路完全一样；派的也是真的 `dblclick`，坐标真的落在那个词上。
 */
import zh from "../../src/i18n/zh.json";
import { ENDING_JUMP, HERO_LOOKUP_WORD, VOCAB_JUMP } from "./content";
import { activeScene, activeShotName } from "./index";

/** 截图脚本等的就是这个属性。 */
const READY_ATTR = "data-shot-ready";

/** 页面上所有动画/过渡一律停掉，否则同一个场景两次截图会不一样。 */
const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (key: string) => (zh as Record<string, string>)[key] ?? key;

/** 谁先到算谁；等不到的东西一律有兜底，绝不把整个场景挂在一个 await 上。 */
const atMost = <T,>(ms: number, work: Promise<T>) =>
  Promise.race([work, sleep(ms)]);

/** 两帧 + 一小段静默，等 React 提交完、图片解码完。 */
async function settle(): Promise<void> {
  // 标签页不可见时 rAF 根本不会触发（后台节流），所以必须给它一个上限 ——
  // 否则在没打开的窗口里跑，场景会永远停在第一次 settle 上，连超时都等不到。
  await atMost(500, new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(120);
  await atMost(2000, document.fonts.ready.catch(() => undefined));
  await atMost(5000, Promise.all(
    [...document.images]
      .filter((img) => !img.complete)
      .map((img) => new Promise<void>((r) => {
        img.addEventListener("load", () => r(), { once: true });
        img.addEventListener("error", () => r(), { once: true });
      })),
  ));
}

/** 轮询直到 `find()` 返回东西；超时是硬错误，不是「拍一张凑合的」。 */
async function waitFor<T>(what: string, find: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = find();
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(80);
  }
}

/* ------------------------------------------------------------------ *
 * 找元素：一律按可见文案或 aria-label，取自应用自己的词条表
 * ------------------------------------------------------------------ */

const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>("button")];

const byLabel = (label: string, scope?: ParentNode): HTMLElement | null =>
  buttons(scope).find((b) => b.getAttribute("aria-label") === label) ?? null;

const byText = (label: string, scope?: ParentNode): HTMLElement | null =>
  buttons(scope).find((b) => b.textContent?.trim().startsWith(label)) ?? null;

/**
 * 左栏的行没有 test id，也不该为了截图去 src/ 里加一个 —— harness 的规矩是
 * 「src/ 不知道 harness 存在」。所以按行上显示的字去找。
 */
const FILTER_LABEL_KEY: Record<string, string> = {
  all: "sidebar.allBooks",
  reading: "sidebar.currentlyReading",
  finished: "sidebar.finished",
  chats: "sidebar.chats",
  vocab: "sidebar.vocab",
  review: "sidebar.review",
  notes: "sidebar.notes",
  explanations: "sidebar.explanations",
  stats: "sidebar.readingStats",
};

function sidebarRow(filterId: string): HTMLElement | null {
  const key = FILTER_LABEL_KEY[filterId];
  if (!key) return null;
  // 侧栏在 <aside> 里；限定范围，免得撞上正文里同名的字。
  return byText(text(key), document.querySelector("aside") ?? document.body);
}

/* ------------------------------------------------------------------ *
 * 阅读器
 * ------------------------------------------------------------------ */

interface FoliateContents {
  index: number;
  doc: Document;
}

interface FoliateView extends HTMLElement {
  renderer?: { getContents(): FoliateContents[]; next(): void; prev(): void };
}

/** 正文那一份 document。书还没铺完时返回 null。 */
function readerContents(): FoliateContents | null {
  const view = document.querySelector<FoliateView>("foliate-view");
  const contents = view?.renderer?.getContents?.() ?? [];
  const first = contents[0];
  return first?.doc?.body?.textContent?.trim() ? first : null;
}

const waitForBook = () => waitFor("正文铺好", readerContents, 25_000);

/** 正文里某个词的位置，换算到宿主页面的坐标系。 */
interface WordHit {
  doc: Document;
  /** iframe 自己坐标系里的点，`dblclick` 用它。 */
  local: { x: number; y: number };
  /** 宿主页面坐标系里的同一个点，用来判断这个词这一页看不看得见。 */
  host: { x: number; y: number };
}

function findWord(word: string): WordHit[] {
  const contents = readerContents();
  if (!contents) return [];
  const { doc } = contents;
  const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
  if (!frame) return [];

  const hits: WordHit[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.nodeValue ?? "";
    for (let at = data.indexOf(word); at >= 0; at = data.indexOf(word, at + 1)) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      if (!box.width) continue;
      const local = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      hits.push({ doc, local, host: { x: frame.x + local.x, y: frame.y + local.y } });
    }
  }
  return hits;
}

/**
 * 这个点当前这一页是不是真的看得见。分栏排版下整章都在 iframe 里铺开，
 * 翻页只是平移 —— 光有坐标不够，得问一句「这个点上现在是不是正文」。
 */
function visibleInReader(host: { x: number; y: number }): boolean {
  if (host.x < 0 || host.y < 0) return false;
  if (host.x > document.documentElement.clientWidth) return false;
  if (host.y > document.documentElement.clientHeight) return false;
  return Boolean(document.elementFromPoint(host.x, host.y)?.closest("foliate-view"));
}

/**
 * 翻页直到这个词落在看得见的一页上，然后双击它。
 *
 * 派的是完整的一串鼠标事件，因为 `useReaderInteractions` 挂的是 `dblclick`，
 * 而它取词靠的是 `caretRangeFromPoint(clientX, clientY)` —— 坐标必须真的落在
 * 那个词上，随便找个元素 `.click()` 是骗不过去的。
 */
async function lookupWord(word: string, maxTurns = 6): Promise<void> {
  await waitForBook();
  const view = document.querySelector<FoliateView>("foliate-view");

  let hit: WordHit | undefined;
  for (let turn = 0; turn <= maxTurns; turn++) {
    hit = findWord(word).find((candidate) => visibleInReader(candidate.host));
    if (hit) break;
    view?.renderer?.next?.();
    await sleep(320);
  }
  if (!hit) throw new Error(`翻了 ${maxTurns} 页也没让 "${word}" 露出来`);

  const { doc, local } = hit;
  const target = doc.elementFromPoint(local.x, local.y);
  if (!target) throw new Error(`"${word}" 的坐标上没有元素`);

  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: doc.defaultView,
    clientX: local.x,
    clientY: local.y,
  } as const;
  for (const [type, detail] of [
    ["mousedown", 1], ["mouseup", 1], ["click", 1],
    ["mousedown", 2], ["mouseup", 2], ["click", 2], ["dblclick", 2],
  ] as const) {
    target.dispatchEvent(new MouseEvent(type, { ...common, detail }));
  }

  // 取词是延迟触发的（要先让三击有机会到达），所以卡片不会立刻出现。
  await waitFor(`"${word}" 的查词卡`, () => document.querySelector('[role="dialog"], [data-card="learning"]')
    ?? buttons().find((b) => b.textContent?.trim() === text("reader.card.collect"))?.closest("div"));
  await settle();
}

/* ------------------------------------------------------------------ *
 * AI 侧栏
 * ------------------------------------------------------------------ */

async function openAiPanel(): Promise<void> {
  const toggle = await waitFor("AI 助手按钮", () => byLabel(text("reader.aiAssistant")));
  toggle.click();
  await waitFor("侧栏输入框", () => document.querySelector("textarea"));
  await settle();
}

/**
 * 把侧栏拖到指定宽度。默认 525px：首图里嫌宽（正文只剩两条窄栏），侧栏特写里
 * 又嫌窄，所以两个方向都要能调。
 *
 * 走的是那条真的拖拽把手（`useSidePanelResize`）：一次 pointerdown 加一次
 * pointerup 就够 —— 松手时它按 clientX 重算最终宽度，中间的 pointermove 只
 * 影响拖动过程中的实时预览。宽度不写进设置里，所以只能这么拖。
 */
async function setAiPanelWidth(target: number): Promise<void> {
  const handle = await waitFor(
    "侧栏的拖拽把手",
    () => document.querySelector<HTMLElement>("div.cursor-col-resize"),
  );
  const box = handle.getBoundingClientRect();
  const startX = box.x + box.width / 2;
  const current = (handle.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? 525;
  const common = { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true };

  handle.dispatchEvent(new PointerEvent("pointerdown", { ...common, clientX: startX, clientY: box.y + 20 }));
  window.dispatchEvent(new PointerEvent("pointerup", {
    ...common,
    // delta = startX - clientX，往右拖就是变窄。
    clientX: startX + (current - target),
    clientY: box.y + 20,
  }));
  await settle();
}

/** 从对话列表里挑一轮已经答完的对话 —— 比现场发一条更稳，也不需要假后端。 */
async function openChat(title: string): Promise<void> {
  const picker = await waitFor("对话列表入口", () => byText(text("ai.newChat")));
  picker.click();
  const row = await waitFor(`对话「${title}」`, () => byText(title));
  row.click();
  // 「来源」那一栏是解析 metadata 之后才画的，等它出现就等于等到了整轮答案 ——
  // 角标本身是按钮不是链接，按 href 找是找不到的。
  await waitFor("答案的来源栏", () => document.body.innerText.includes(text("ai.sources")));
  await settle();
}

/**
 * 点回答里的第 n 个角标。
 *
 * 角标是 `CitationChip` 画的 `<button aria-label="Source n">`，正文里和底下
 * 那排来源芯片用的是同一个组件 —— 按 DOM 顺序第一个就是正文里的那个。
 *
 * 点完应用会在目标章节里检索这句原文、跳过去、把它高亮三秒。所以这一步必须
 * 放在场景的最后：等得太久，快门按下时高亮已经撤了。
 */
async function clickCitation(marker: number, sectionIndex: number): Promise<void> {
  const chip = await waitFor(`角标 S${marker}`, () => byLabel(`Source ${marker}`));
  chip.click();
  // 跨章跳转要先把那一章加载出来再检索，快的时候一百毫秒，慢的时候两秒。
  await waitFor(
    `阅读器停在第 ${sectionIndex} 节`,
    () => (readerContents()?.index === sectionIndex ? true : null),
    8000,
  );
  // 同章跳转上面那条立刻就满足了，所以再给高亮一点画出来的时间。
  await sleep(400);
}

/** 展开「回答范围」那个菜单 —— 四档（自动 / 选区 / 本章 / 全书）一次全露出来。 */
async function openScopeMenu(): Promise<void> {
  const label = text("ai.scope.trigger").replace("{{scope}}", text("ai.scope.auto"));
  const trigger = await waitFor("回答范围按钮", () => byText(label));
  trigger.click();
  await waitFor("回答范围菜单", () => document.querySelector('[role="menu"]'));
  await settle();
}

/* ------------------------------------------------------------------ *
 * 每张图各自要摆的样子
 * ------------------------------------------------------------------ */

const ACTIONS: Record<string, () => Promise<void>> = {
  /** 正文 + 查词卡 + 一轮带引用的对话，三块同框。 */
  async hero() {
    await waitForBook();
    await openAiPanel();
    await setAiPanelWidth(420);
    await openChat("他明明说不去拜访宾利");
    await lookupWord(HERO_LOOKUP_WORD);
  },

  /**
   * 左边一份长生词清单（每条带角标、底下一排来源芯片），右边是点了其中一个
   * 角标之后的正文 —— 被引的那一句正高亮着。两边的对应关系是这张图的全部。
   */
  async citations() {
    await waitForBook();
    await openAiPanel();
    await setAiPanelWidth(560);
    await openChat("这一章我会卡住的词");
    await clickCitation(VOCAB_JUMP.marker, VOCAB_JUMP.sectionIndex);
  },

  /**
   * 侧栏特写：展开的回答范围、开着的阅读思考保护、一条明显问全书的问题，以及
   * 回答下面那句「已按你的阅读进度回答（前 34%）」和「结合全书重新回答」。
   *
   * 先点最后一个角标把阅读器带到第二十一章，左边的进度读数才和右边那句 34%
   * 对得上；再展开范围菜单 —— 顺序反了的话，点角标会把菜单关掉。
   */
  async context() {
    await waitForBook();
    await openAiPanel();
    await setAiPanelWidth(600);
    await openChat("达西和伊丽莎白最后会怎么样");
    await clickCitation(ENDING_JUMP.marker, ENDING_JUMP.sectionIndex);
    await openScopeMenu();
  },

  /**
   * 两张等级图共用一个动作：查同一个词、同一句话。差别全在设置里 —— 卡片显示
   * 哪几块由学习者等级定，内容也按等级各生成一份。
   */
  async levelA2() {
    await waitForBook();
    await lookupWord("circumspection");
  },

  async levelC1() {
    await waitForBook();
    await lookupWord("circumspection");
  },
};

/* ------------------------------------------------------------------ *
 * 对外
 * ------------------------------------------------------------------ */

/**
 * 在 `/src/main.tsx` 之前调用。只改地址栏，不碰别的。
 */
export function applySceneRoute(): void {
  const scene = activeScene();
  if (!scene?.route) return;
  // 保留 query，`?shot=` 后面还要被 fixture 层读到。
  window.history.replaceState(null, "", `${scene.route}${window.location.search}`);
}

/**
 * 应用挂载之后调用。做完把 `data-shot-ready` 打上。
 */
export async function runScene(): Promise<void> {
  const name = activeShotName();
  const scene = activeScene();
  if (!name || !scene) return;

  const style = document.createElement("style");
  style.textContent = FREEZE_CSS;
  document.head.append(style);

  try {
    if (scene.libraryFilter) {
      const row = await waitFor(`左栏的「${scene.libraryFilter}」`, () => sidebarRow(scene.libraryFilter as string));
      row.click();
    }

    await ACTIONS[name]?.();

    await settle();
    document.documentElement.setAttribute(READY_ATTR, name);
    console.info(`[shot:${name}] ready`);
  } catch (error) {
    // 没就位也要打标记，否则截图脚本只能干等到超时，还看不出是哪一步炸的。
    // 原因也挂到 DOM 上：无头 Chrome 的控制台没人看得见，脚本得能读出来。
    const why = error instanceof Error ? error.message : String(error);
    document.documentElement.setAttribute("data-shot-error", why);
    document.documentElement.setAttribute(READY_ATTR, `${name}:failed`);
    console.error(`[shot:${name}] 布置失败`, error);
  }
}
