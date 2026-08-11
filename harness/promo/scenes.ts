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
import {
  ENDING_JUMP,
  HERO_LOOKUP_WORD,
  MASTERY_WORD,
  PROMO_CUSTOM_MODULE_NAME,
  VOCAB_JUMP,
} from "./content";
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
 * 设置 · 个人（用户画像）
 * ------------------------------------------------------------------ */

/**
 * 打开设置里的某一节。
 *
 * 用户画像不是一条路由 —— 它是设置模态框里的「个人」那一节
 * （`SettingsModal` 的 `personal`）。入口就是左栏最底下那一行（头像 + 「设置」），
 * 所以这里先点它，再点节名，和读者的路径一模一样。
 */
async function openSettingsSection(sectionLabel: string): Promise<void> {
  const entry = await waitFor("左栏底部的设置入口", () =>
    buttons(document.querySelector("aside") ?? document.body)
      .find((b) => b.textContent?.includes(text("settings.title"))) ?? null);
  entry.click();

  const dialog = await waitFor("设置模态框", () => document.querySelector<HTMLElement>('[role="dialog"]'));
  const row = await waitFor(`设置里的「${sectionLabel}」`, () => byText(sectionLabel, dialog));
  row.click();
  await settle();
}

/**
 * 把某张画像卡的「依据」一路摊开：先展开卡片自己那一句依据，再点进「查看
 * 原始记录」，露出写这条结论时模型真正读到的那份聚合记录。
 *
 * 卡片上没有可以直接找的标识，就按卡头显示的维度名定位到那张卡，再在它内部找
 * 按钮 —— 三张卡上的「展开」字样一模一样，不限定范围会点到第一张。
 */
async function expandProfileEvidence(slotLabel: string): Promise<void> {
  const card = await waitFor(`画像卡「${slotLabel}」`, () => {
    const heading = [...document.querySelectorAll<HTMLElement>("h5")]
      .find((h) => h.textContent?.trim() === slotLabel);
    return heading?.closest<HTMLElement>("div.rounded-xl") ?? null;
  });

  (await waitFor("卡片上的「展开」", () => byText(text("profile.expand"), card))).click();
  (await waitFor("「查看原始记录」", () =>
    buttons(card).find((b) => b.textContent?.trim() === text("profile.evidence.viewRecords")) ?? null)).click();
  // 记录是异步取回来的（`profile_card_evidence`），等那句「记录 → 结论 → 提示词」
  // 出现才算真的摊开了 —— 否则拍到的是一行「正在取出…」。
  await waitFor("原始记录", () =>
    card.textContent?.includes(text("profile.evidence.chain")) ? true : null);
  await settle();
}

/**
 * 把设置模态框滚到某个小标题贴着顶。
 *
 * 画像页比模态框高得多：上面还有「AI 现在这样理解你」，下面三张卡加摊开的原始
 * 记录，一屏根本装不下。这张图要的是「自己写的那几行 → 系统总结的结论 → 结论
 * 的依据」这一段连着的内容，所以让画面从「你写的」开始。
 *
 * 滚的是那个小标题相对滚动容器的位置，不是一个拍脑袋的像素数 —— 字号、行高、
 * 文案长度以后再变，这张图的构图也不会跟着漂。
 */
async function scrollSettingsTo(heading: string): Promise<void> {
  // 小标题不是按钮，所以不能用 byText（那个只翻 button）；画像那边是 <p>，
  // 卡片设计那边是 <h4>，两种都收。
  const anchor = await waitFor(`「${heading}」小标题`, () =>
    [...(document.querySelector('[role="dialog"]') ?? document.body).querySelectorAll<HTMLElement>("p, h4")]
      .find((el) => el.textContent?.trim() === heading) ?? null);
  const scroller = anchor.closest<HTMLElement>(".overflow-y-scroll");
  if (!scroller) throw new Error("设置模态框里找不到滚动容器");
  scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  await settle();
}

/* ------------------------------------------------------------------ *
 * 设置 · 划词与卡片
 * ------------------------------------------------------------------ */

/** 「划词与卡片」里的二级页签（划词行为 / 卡片设计 / 选区菜单 / 正文标记）。 */
async function openToolsView(label: string): Promise<void> {
  const tab = await waitFor(`页签「${label}」`, () =>
    buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent?.trim() === label) ?? null);
  tab.click();
  await settle();
}

/**
 * 展开模块列表里的某一行。
 *
 * 行首那个按钮带 `aria-expanded`，和生词本那边同一个套路；自定义模块的行名就是
 * 用户自己起的名字（内置模块走词条表），所以传进来的字要和数据那边同一个常量。
 */
async function expandCardModule(name: string): Promise<void> {
  const row = await waitFor(`模块行「${name}」`, () =>
    buttons().find((b) =>
      b.getAttribute("aria-expanded") !== null && b.textContent?.trim() === name) ?? null);
  row.click();
  // 提示词是自定义模块独有的，等它出现才算编辑器真的展开了。
  await waitFor("提示词输入框", () => document.querySelector("textarea"));
  await settle();
}

/**
 * 点右边预览面板上的「生成真实预览」。
 *
 * 不点的话，自定义模块在预览卡上只是一句占位文案（「此处将展示……」）—— 那是应用
 * 的真实状态，但它证明不了这张图要证明的事：自己写的模块和内置模块一样，会出现在
 * 卡片里、由模型填出内容。点下去走的是 `ai_learning_card`，和读者在正文里查词
 * 是同一条命令，只不过样张里模型那一端是 `content.ts` 里那份定稿。
 */
async function generateRealPreview(): Promise<void> {
  const button = await waitFor("「生成真实预览」", () =>
    buttons().find((b) => b.textContent?.trim() === text("settings.tools.generateRealPreview")) ?? null);
  button.click();
  // 按钮上的说明会从「本地样例，不消耗 API」换成「当前显示真实 AI 结果」，
  // 换完才说明返回值已经渲染进卡片了。
  await waitFor("真实结果", () =>
    document.body.textContent?.includes(text("settings.tools.realPreviewActive")) ? true : null);
  await settle();
}

/* ------------------------------------------------------------------ *
 * 生词本
 * ------------------------------------------------------------------ */

/** 从某个元素往上找真正在滚的那个祖先；找不到就是整页在滚。 */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 4) return node;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * 展开生词清单里的某一行，然后把画面滚到这一行贴着顶。
 *
 * 生词页上面还有一大片（统计、复习堆、筛选条），展开的那一行落在屏幕外面很正常。
 * 滚的是「这一行相对滚动容器」的距离，不是拍脑袋的像素数 —— 上面那片以后加减
 * 一块，这张图的构图也不跟着漂。
 */
async function expandVocabRow(word: string): Promise<void> {
  const row = await waitFor(`生词行「${word}」`, () =>
    buttons().find((b) => b.getAttribute("aria-expanded") !== null && b.textContent?.trim().startsWith(word)) ?? null);
  row.click();

  // 掌握度时间线是展开之后才去取的（`list_mastery_events`），等它出来再定构图，
  // 否则滚完页面还会被它撑高一截。
  await waitFor("掌握度时间线", () =>
    document.body.textContent?.includes(text("vocab.mastery.timelineHeading")) ? true : null);

  const card = row.closest<HTMLElement>("div.rounded-\\[10px\\]") ?? row;
  const scroller = scrollerOf(card);
  // 滚一次不够：页面上半段（复习堆那几块）是各自异步取回来的，晚到一块就把下面
  // 的内容整体往下推，构图跟着漂。所以滚完再量一次，直到不动了为止。
  for (let pass = 0; pass < 6; pass += 1) {
    const off = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    if (Math.abs(off) < 4) break;
    scroller.scrollTop += off;
    await settle();
  }
}

/* ---------------- 书籍详情 ---------------- */

/**
 * 把「这本书对你」那张卡滚到贴着顶。
 *
 * 详情页上面还有封面、简介、难度那几块，卡片一进来就在屏幕外。和生词本那边
 * 同一个道理：量的是卡片相对滚动容器的距离，量完再量一次 —— 覆盖率、生词
 * 清单都是各自异步取回来的，晚到一块就把下面顶下去。
 */
async function scrollCardToTop(heading: string): Promise<void> {
  const anchor = await waitFor(`「${heading}」小标题`, () =>
    [...document.querySelectorAll<HTMLElement>("h2, h3")]
      .find((node) => node.textContent?.trim() === heading) ?? null);
  const card = anchor.closest<HTMLElement>("section") ?? anchor;
  const scroller = scrollerOf(card);
  // 详情页的页头是 sticky 的，滚到「容器顶」等于滚到页头底下。让开它那么高。
  const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
  for (let pass = 0; pass < 6; pass += 1) {
    const off = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - header - 12;
    if (Math.abs(off) < 4) break;
    scroller.scrollTop += off;
    await settle();
  }
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

  /**
   * 生词本里摊开的那一条：档位、「自动判定」、一句说清凭什么的话、四档随手改，
   * 以及底下那条时间线。主角是时间线 —— 它证明这个档位有来由，而且一按就能推翻。
   */
  async vocab() {
    await expandVocabRow(MASTERY_WORD);
  },

  /**
   * 「这本书对你」：覆盖率落在那把带 95% / 98% 两条线的尺子上，四类词次的构成，
   * 以及摊开的那张「还不认识的词」清单。
   *
   * 清单是点开的，不是默认展开的 —— 界面本来就要点一下「看看那 X% 是哪些词」，
   * 这张图里那一下也真的点了。图上的每个数都出自
   * `scripts/promo-coverage.mjs`：真 EPUB，端上同一套分词和分类规则。
   */
  async coverage() {
    // 覆盖率是异步算的，先等结论那句话出现，再点展开 —— 反了的话按钮还不在。
    await waitFor("覆盖率结论", () =>
      document.body.textContent?.includes(text("bookCoverage.heading")) ? true : null);
    // 按钮上带着覆盖率（「看看那 95.5% 是哪些词」），所以只认插值之前那一截。
    const prefix = text("bookCoverage.action.showWords").split("{{")[0].trim();
    const show = await waitFor(`「${prefix}…」`, () =>
      buttons().find((b) => b.textContent?.trim().startsWith(prefix)) ?? null);
    show.click();
    await waitFor("还不认识的词清单", () =>
      document.body.textContent?.includes(text("bookCoverage.words.group.frequent")) ? true : null);
    await scrollCardToTop(text("bookCoverage.heading"));
  },

  /**
   * 用户画像。图的主角是摊开的那条依据 —— 结论下面先是总结器自己写的那一句，
   * 再往里一层是它当时读到的原始记录。每张卡底下的「移动到上段修改」照常在框里：
   * 冲突时以你写的那段为准，这一条得看得见。
   */
  /**
   * 卡片模块：左边是这张卡的模块列表（开着的五块、关着的八块、能上下挪），
   * 其中一行是读者自己写的模块，摊开着，提示词一字不落；右边是应用自己那块
   * 预览，里面那张卡上就有这个模块产出的内容。
   *
   * 预览是点进「卡片设计」时应用自己打开的，不是场景多点的一下 —— 这一页的
   * 常态就是边改边看。
   *
   * 最后要滚一下：模块列表上面还压着密度、宽度、例句数量三行设置，不滚的话画面
   * 从那三行开始，提示词就被切在下边框外 —— 而提示词正是这张图要证明的东西。
   */
  async cards() {
    await openSettingsSection(text("settings.tools.title"));
    await openToolsView(text("settings.tools.views.cards"));
    await expandCardModule(PROMO_CUSTOM_MODULE_NAME);
    await generateRealPreview();
    await scrollSettingsTo(text("settings.tools.modulesTitle"));
  },

  async profile() {
    await openSettingsSection(text("settings.personal.title"));
    await expandProfileEvidence(text("profile.slot.syntax_explain"));
    await scrollSettingsTo(text("profile.yourText.heading"));
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

    // 键是**场景名**（`SCENES` 的键），不是 SHOTS 里那个图名 —— 两者可以不同
    // （`mastery` 这张图用的是 `vocab` 场景）。对不上时这里会静悄悄什么都不做，
    // 拍出来还是一张「刚进页面」的图，所以没动作的场景要在日志里说一声。
    if (ACTIONS[name]) await ACTIONS[name]();
    else console.info(`[shot:${name}] 这个场景没有动作，只拍进场状态`);

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
