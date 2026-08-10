#!/usr/bin/env node
/**
 * 拍 README 里的八张图。
 *
 * 图不是画的：这个脚本启动 `npm run smoke`（真实的 React 前端 + 真实的
 * foliate-js，只有 Tauri 那一侧是 mock），把界面驱动到指定状态，然后截图。
 * 应用渲染不出来的效果，图上就不会有 —— 这是这套做法的全部意义。
 *
 * 每一张图对应一个 “scene”。scene 名走 URL：`?shot=hero`，由
 * `harness/promo/` 接住：换上这一张图要用的书库、切到该去的页面、点开该点开
 * 的东西，就位后在 <html> 上打一个 `data-shot-ready`。脚本等到那个属性出现
 * 才按快门 —— 不靠 sleep 猜，所以同一个场景拍两次结果一样。
 *
 *   node scripts/shoot-readme.mjs              # 全部
 *   node scripts/shoot-readme.mjs hero vocab   # 只拍这两张
 *   node scripts/shoot-readme.mjs --keep       # 拍完不关 harness
 *   node scripts/shoot-readme.mjs --out=/tmp   # 换个输出目录（试拍别脏了仓库）
 *
 * 输出：assets/screenshots/<name>.png（2x）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 1440;
const ORIGIN = `http://localhost:${PORT}`;
/**
 * 场景就位的等待上限。超时就照原样拍一张，方便看卡在哪儿。
 * 必须比场景里最长的那个等待（等 EPUB 铺完，25 秒）更宽，否则脚本会先一步
 * 放弃，拍到的是一张还在加载的图。
 */
const READY_TIMEOUT_MS = 45_000;

const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * 八张图。`name` 是写出去的文件名 —— 必须和 README 里 `![](…)` 引的名字一致；
 * `scene` 是 harness 里的场景名；`size` 是 CSS 像素的窗口尺寸（按 2x 导出，
 * 实际像素是这里的两倍）。顺序就是 README 里的顺序。
 */
const SHOTS = [
  { name: "hero", scene: "hero", size: [1280, 840] },
  // 等级那一张在 README 里是左右并排的两图，所以拍成两张，各拍各的等级。
  { name: "level-a2", scene: "levelA2", size: [820, 1040] },
  { name: "level-c1", scene: "levelC1", size: [820, 1040] },
  // 画像在设置模态框里，模态框宽度封顶 780、高度封顶 760，窗口再大也只是把两边
  // 的书库露得更多。收到 1000 是让内容占满画面，同时留一圈压暗的背景说明它开在哪儿。
  { name: "profile", scene: "profile", size: [1000, 980] },
  { name: "context", scene: "context", size: [1020, 880] },
  { name: "citations", scene: "citations", size: [1280, 900] },
  // 摊开的那一条整个有 809px 高（词头 + 释义 + 原句 + 掌握度面板），页头又占掉
  // 250px —— 1100 刚好把这一整条从头到尾装进画面。矮一点，时间线和「我其实不
  // 认识」就掉出去了，而那两块正是这张图要证明的东西。
  { name: "mastery", scene: "vocab", size: [1180, 1100] },
  { name: "coverage", scene: "coverage", size: [1180, 1240] },
  // 预览面板要到 xl（1280）才停在模态框旁边，窄一点它就翻上来盖住设置本身。
  // 这一页的意思正是「左边改、右边看」，所以窗口必须过那条线。
  { name: "modules", scene: "cards", size: [1360, 940] },
  { name: "mcp", scene: "mcp", size: [1180, 900] },
];

/** 不进 README，手动检查用。`node scripts/shoot-readme.mjs library` 拍得到。 */
const EXTRA_SHOTS = [{ name: "library", scene: "library", size: [1280, 1180] }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * harness 进程
 * ------------------------------------------------------------------ */

async function isUp() {
  try {
    return (await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** 已经在跑就复用（开发时常态），否则起一个我们自己负责关掉的。 */
async function ensureHarness() {
  if (await isUp()) {
    console.log(`· harness 已在 ${ORIGIN}，复用`);
    return null;
  }
  console.log("· 启动 harness …");
  const child = spawn("npm", ["run", "smoke"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await isUp()) return child;
    await sleep(400);
  }
  child.kill("SIGTERM");
  throw new Error(`harness 60 秒内没起来（${ORIGIN}）`);
}

/* ------------------------------------------------------------------ *
 * Chrome（CDP）
 *
 * 用调试协议而不是 `--screenshot`：那个开关是「开完就拍」，没法等页面说自己
 * 就位，拍出来时好时坏。CDP 可以先轮询 data-shot-ready 再按快门。
 * ------------------------------------------------------------------ */

async function launchChrome() {
  if (!existsSync(CHROME)) {
    throw new Error(`找不到 Chrome：${CHROME}\n设 CHROME_BIN 指向可执行文件。`);
  }
  const profile = await mkdtemp(join(tmpdir(), "lantern-shot-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  // `--remote-debugging-port=0` 让系统分配端口，实际端口写在这个文件第一行。
  const portFile = join(profile, "DevToolsActivePort");
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (port) return { child, profile, port: Number(port) };
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
  throw new Error("Chrome 没有报出调试端口");
}

/** 极简 CDP 客户端：够用就行，不引入 puppeteer。 */
async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", () => bad(new Error("CDP 连接失败")), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.bad(new Error(`${msg.error.message} (${waiter.method})`));
    else waiter.ok(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((ok, bad) => {
      const id = ++seq;
      pending.set(id, { ok, bad, method });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => ws.close(), targetId: target.id };
}

const evaluate = async (cdp, expression) => {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result?.value;
};

async function capture(cdp, shot, outFile) {
  const [width, height] = shot.size;

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?shot=${encodeURIComponent(shot.scene)}` });

  // 等场景自己说就位。超时不算失败 —— 拍一张出来，比只留一条报错好定位。
  let ready = null;
  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until) {
    ready = await evaluate(cdp, "document.documentElement.getAttribute('data-shot-ready')");
    if (ready) break;
    await sleep(150);
  }

  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(outFile, Buffer.from(data, "base64"));

  if (!ready) return "场景超时（照原样拍了一张）";
  if (String(ready).endsWith(":failed")) {
    const why = await evaluate(cdp, "document.documentElement.getAttribute('data-shot-error')");
    return `场景布置报错 — ${why ?? "原因不明"}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const outArg = argv.find((a) => a.startsWith("--out="));
const OUT_DIR = outArg ? resolve(outArg.slice(6)) : join(root, "assets", "screenshots");
const wanted = argv.filter((a) => !a.startsWith("--"));

const ALL = [...SHOTS, ...EXTRA_SHOTS];
const queue = wanted.length ? ALL.filter((s) => wanted.includes(s.name)) : SHOTS;

if (wanted.length && queue.length !== wanted.length) {
  const missing = wanted.filter((n) => !ALL.some((s) => s.name === n));
  console.error(`未知的图名：${missing.join(", ")}\n可选：${ALL.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

let harness = null;
let chrome = null;
let failed = 0;

try {
  harness = await ensureHarness();
  chrome = await launchChrome();
  const cdp = await connect(chrome.port);

  for (const shot of queue) {
    process.stdout.write(`· ${shot.name} … `);
    try {
      const warning = await capture(cdp, shot, join(OUT_DIR, `${shot.name}.png`));
      if (warning) {
        failed++;
        console.log(`⚠ ${warning}`);
      } else {
        console.log("ok");
      }
    } catch (error) {
      failed++;
      console.log(`失败 — ${error instanceof Error ? error.message : error}`);
    }
  }
  cdp.close();
} finally {
  if (chrome) {
    chrome.child.kill("SIGKILL");
    // Chrome 被 SIGKILL 之后还在往 profile 里写，直接删会撞上 ENOTEMPTY；
    // 重试几次还不行就留着 —— 临时目录不值得为它把整次拍摄判成失败。
    try {
      rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 系统自己会回收 tmpdir。 */
    }
  }
  if (harness && !keep) harness.kill("SIGTERM");
  else if (harness) console.log(`· harness 留在 ${ORIGIN}（--keep）`);
}

console.log(
  failed
    ? `\n${queue.length - failed}/${queue.length} 张干净，${failed} 张有问题 → ${OUT_DIR}`
    : `\n${queue.length} 张全部写入 ${OUT_DIR}`,
);
process.exit(failed ? 1 : 0);
