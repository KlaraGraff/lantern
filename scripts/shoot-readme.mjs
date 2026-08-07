#!/usr/bin/env node
/**
 * 拍 README 里的八张图。
 *
 * 图不是画的：这个脚本启动 `npm run smoke`（真实的 React 前端 + 真实的
 * foliate-js，只有 Tauri 那一侧是 mock），把界面驱动到指定状态，然后用
 * headless Chrome 截图。应用渲染不出来的效果，图上就不会有——这是这套做法
 * 的全部意义。
 *
 * 每一张图对应一个 “scene”。scene 名走 URL：`?shot=hero`，由
 * `harness/shots.ts` 接住，负责换上这一张图要用的 fixture 并把 UI 点开
 * （打开查词卡、展开侧栏、切到某个设置分栏……）。scene 报告自己就位的方式是
 * 在 <html> 上打一个 `data-shot-ready` 属性；脚本等到它出现才按快门。
 *
 *   node scripts/shoot-readme.mjs              # 全部八张
 *   node scripts/shoot-readme.mjs hero vocab   # 只拍这两张
 *   node scripts/shoot-readme.mjs --keep       # 拍完不关 harness，方便手动看
 *
 * 输出：assets/screenshots/<name>.png（2x）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "assets", "screenshots");
const PORT = 1440;
const ORIGIN = `http://localhost:${PORT}`;
/** 单张图的上限；到点杀掉 Chrome，PNG 已写出就算成功（见 shoot()）。 */
const SHOT_TIMEOUT_MS = 30_000;

const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * 八张图。`scene` 是 harness 里的场景名，`size` 是 CSS 像素的窗口尺寸
 * （截图按 2x 导出，所以实际像素是这里的两倍）。
 *
 * 顺序就是它们在 README 里出现的顺序。
 */
const SHOTS = [
  { name: "hero", scene: "hero", size: [1280, 800] },
  { name: "levels", scene: "levels", size: [900, 560] },
  { name: "context", scene: "context", size: [1280, 800] },
  { name: "citations", scene: "citations", size: [1280, 800] },
  { name: "vocab", scene: "vocab", size: [1180, 740] },
  { name: "difficulty", scene: "difficulty", size: [1180, 860] },
  { name: "cards", scene: "cards", size: [1180, 880] },
  { name: "mcp", scene: "mcp", size: [1180, 900] },
];

/* ------------------------------------------------------------------ *
 * harness 进程
 * ------------------------------------------------------------------ */

async function isUp() {
  try {
    const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
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
    detached: false,
  });
  if (!(await waitUntilUp())) {
    child.kill("SIGTERM");
    throw new Error(`harness 60 秒内没起来（${ORIGIN}）`);
  }
  return child;
}

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

async function shoot(shot) {
  if (!existsSync(CHROME)) {
    throw new Error(
      `找不到 Chrome：${CHROME}\n设 CHROME_BIN 指向你的 Chrome 可执行文件。`,
    );
  }
  const [w, h] = shot.size;
  const out = join(OUT_DIR, `${shot.name}.png`);
  const profile = await mkdtemp(join(tmpdir(), "lantern-shot-"));
  const url = `${ORIGIN}/?shot=${encodeURIComponent(shot.scene)}`;

  const args = [
    "--headless=new",
    `--screenshot=${out}`,
    `--window-size=${w},${h}`,
    "--force-device-scale-factor=2",
    "--hide-scrollbars",
    "--default-background-color=00000000",
    // scene 就位后 harness 会停掉动画，所以虚拟时间可以给得很足而不会拖慢
    "--virtual-time-budget=15000",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    url,
  ];

  // Vite 的客户端连接一直开着，虚拟时间就一直排不干净：Chrome 早就把 PNG 写
  // 完了，进程却不肯退。所以不等它自己退——给一个看门狗，到点就杀，文件在就算
  // 成功。
  await new Promise((resolvePromise, reject) => {
    const chrome = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn(arg);
    };
    const watchdog = setTimeout(() => {
      chrome.kill("SIGKILL");
      if (existsSync(out)) finish(resolvePromise);
      else finish(reject, new Error(`Chrome 超时且没有产出文件\n${stderr.slice(-2000)}`));
    }, SHOT_TIMEOUT_MS);

    chrome.stderr.on("data", (d) => (stderr += d));
    chrome.on("error", (error) => finish(reject, error));
    chrome.on("exit", (code) => {
      if (existsSync(out)) finish(resolvePromise);
      else finish(reject, new Error(`Chrome 退出码 ${code}\n${stderr.slice(-2000)}`));
    });
  }).finally(() => rmSync(profile, { recursive: true, force: true }));

  return out;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const wanted = argv.filter((a) => !a.startsWith("--"));
const queue = wanted.length
  ? SHOTS.filter((s) => wanted.includes(s.name))
  : SHOTS;

if (wanted.length && queue.length !== wanted.length) {
  const known = SHOTS.map((s) => s.name).join(", ");
  const missing = wanted.filter((n) => !SHOTS.some((s) => s.name === n));
  console.error(`未知的图名：${missing.join(", ")}\n可选：${known}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

let harness = null;
let failed = 0;
try {
  harness = await ensureHarness();
  for (const shot of queue) {
    process.stdout.write(`· ${shot.name} … `);
    try {
      await shoot(shot);
      console.log("ok");
    } catch (error) {
      failed++;
      console.log("失败");
      console.error(`  ${error instanceof Error ? error.message : error}`);
    }
  }
} finally {
  if (harness && !keep) harness.kill("SIGTERM");
  else if (harness) console.log(`· harness 留在 ${ORIGIN}（--keep）`);
}

console.log(
  failed
    ? `\n${queue.length - failed}/${queue.length} 张成功，${failed} 张失败`
    : `\n${queue.length} 张全部写入 assets/screenshots/`,
);
process.exit(failed ? 1 : 0);
