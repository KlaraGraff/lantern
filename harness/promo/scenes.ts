/**
 * 场景的「动作」部分 —— 需要摸到 DOM 才能做的事。
 *
 * 数据在 `index.ts`（设置、路由），这里只管两件：
 *   1. 应用挂载**之前**把地址栏改成场景要的路由，这样 BrowserRouter 一开局
 *      就在对的页面，不会先闪一下书库再跳走；
 *   2. 应用挂载**之后**去点该点的东西，然后在 <html> 上打一个
 *      `data-shot-ready`，告诉截图脚本可以按快门了。
 *
 * 为什么用「点」而不是直接改 state：点得动才说明这个界面真的存在。样张的全部
 * 价值就在这一句上 —— 一旦开始走后门，图就又开始撒谎了。
 */
import zh from "../../src/i18n/zh.json";
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

/** 两帧 + 一小段静默，等 React 提交完、图片解码完。 */
async function settle(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await sleep(120);
  try {
    await document.fonts.ready;
  } catch {
    /* 字体 API 不在就算了，不值得为它中断。 */
  }
  await Promise.all(
    [...document.images]
      .filter((img) => !img.complete)
      .map((img) => new Promise<void>((r) => {
        img.addEventListener("load", () => r(), { once: true });
        img.addEventListener("error", () => r(), { once: true });
      })),
  );
}

/** 轮询直到 `find()` 返回东西，或者超时返回 null。 */
async function waitFor<T>(find: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = find();
    if (hit) return hit;
    if (Date.now() > until) return null;
    await sleep(80);
  }
}

/**
 * 左栏的行没有 test id，也不该为了截图去 src/ 里加一个 —— harness 的规矩是
 * 「src/ 不知道 harness 存在」。所以按行上显示的字去找，字直接取自应用自己的
 * 词条表，不另抄一份。
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
  const label = key ? (zh as Record<string, string>)[key] : null;
  if (!label) return null;
  // 侧栏在 <aside> 里；限定范围，免得撞上正文里同名的字。
  const scope = document.querySelector("aside") ?? document.body;
  return (
    [...scope.querySelectorAll<HTMLElement>("button")].find(
      (b) => b.textContent?.trim().startsWith(label),
    ) ?? null
  );
}

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
      const row = await waitFor(() => sidebarRow(scene.libraryFilter as string));
      if (row) row.click();
      else console.warn(`[shot:${name}] 左栏找不到 "${scene.libraryFilter}" 这一行`);
    }

    await settle();
    document.documentElement.setAttribute(READY_ATTR, name);
    console.info(`[shot:${name}] ready`);
  } catch (error) {
    // 没就位也要打标记，否则截图脚本只能干等到超时，还看不出是哪一步炸的。
    document.documentElement.setAttribute(READY_ATTR, `${name}:failed`);
    console.error(`[shot:${name}] 布置失败`, error);
  }
}
