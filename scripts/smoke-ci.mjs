#!/usr/bin/env node
/**
 * CI driver for the browser smoke harness.
 *
 * `npm run smoke` boots the frontend in Chrome against a mocked Tauri backend
 * and, with `?smoke=1`, sweeps every route clicking every safe control. That
 * sweep only ever ran by hand. This drives it headlessly once per layout, gates
 * on both results, and writes each full report to `dist/smoke-report-*.json`.
 *
 *   node scripts/smoke-ci.mjs
 *   node scripts/smoke-ci.mjs --keep      # leave the harness up afterwards
 *
 * Chrome is driven over the DevTools protocol with no dependencies: node's
 * global WebSocket is all it takes, and `scripts/shoot-readme.mjs` already
 * establishes that this repo spawns Chrome itself rather than carrying a
 * browser-automation library.
 *
 * The polling contract is the harness's, not ours (see `harness/README.md`):
 * poll `window.__SMOKE_DONE__` rather than awaiting anything, because a fatal
 * render makes the sweep reload the page and resume in a fresh JS realm where
 * any promise we were holding no longer exists.
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
const reportPath = (layout) => join(root, "dist", `smoke-report-${layout.name}.json`);

/**
 * Both layouts, because they are different applications.
 *
 * `useIsNarrow` flips at Tailwind's `md:` (48rem / 768px), and the narrow side
 * is not a reflow — settings become their own screens, panels become sheets.
 * It is the *larger* surface: ~435 actions against desktop's ~194.
 *
 * The window size is pinned rather than left to Chrome because the default is
 * platform-dependent and lands on either side of that line: headless Chrome
 * gives 756px wide on macOS and 800px on the Linux runner. Unpinned, the same
 * commit swept the mobile layout locally and the desktop layout in CI, and
 * nothing in the output said so.
 */
const LAYOUTS = [
  { name: "desktop", window: "1280,800", wantsNarrow: false },
  // 500 rather than a phone's 390: macOS clamps a Chrome window below ~500 wide
  // and silently hands back 500 anyway, so asking for less only makes the log
  // disagree with the viewport. Still well clear of the 768px breakpoint.
  { name: "narrow", window: "500,900", wantsNarrow: true },
];

/** Whole-run ceiling. The sweep allows itself 12 restarts, each a full replay. */
const RUN_TIMEOUT_MS = 8 * 60_000;
/**
 * How long `window.__SMOKE_STEP__` may sit unchanged before we call it wedged.
 * The step stamp advances per action, so this is far above any single click —
 * it is here to fail fast instead of burning the whole run ceiling.
 */
const STUCK_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;
/** Ceiling on one DevTools round trip. Chrome not answering is itself a result. */
const CDP_CALL_TIMEOUT_MS = 15_000;
/** Chrome's own cap on a single `Runtime.evaluate`, well under the round trip. */
const EVALUATE_TIMEOUT_MS = 5_000;
/** How often to print where the sweep is, so a slow run is legible while it runs. */
const HEARTBEAT_MS = 15_000;
/** How long to let a SIGKILLed Chrome actually die before touching its profile. */
const EXIT_GRACE_MS = 5_000;

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

/**
 * `CHROME_BIN` wins; otherwise the macOS install, then whatever the GitHub
 * runner images ship (`google-chrome` is preinstalled on ubuntu-latest).
 */
function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No Chrome found. Tried:\n  ${candidates.join("\n  ")}\n` +
        `Set CHROME_BIN to your Chrome executable.`,
    );
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * harness process
 * ------------------------------------------------------------------ */

async function isUp() {
  try {
    const res = await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await isUp()) return true;
    await sleep(400);
  }
  return false;
}

/** Reuse a harness that is already running (the local case), else own one. */
async function ensureHarness() {
  if (await isUp()) {
    console.log(`· reusing harness already on ${ORIGIN}`);
    return null;
  }
  console.log("· starting harness …");
  // `detached` puts npm and the vite it spawns in their own process group, so
  // `stopHarness` can take the whole tree down. Signalling the npm process
  // alone leaves vite orphaned still holding :1440 — and the next run then
  // silently "reuses" a dev server from a previous checkout.
  const child = spawn("npm", ["run", "smoke"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  if (!(await waitUntilUp())) {
    stopHarness(child);
    throw new Error(`harness did not come up within 90s (${ORIGIN})`);
  }
  return child;
}

function stopHarness(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Group already gone, or the platform refused a negative pid.
    child.kill("SIGTERM");
  }
}

/* ------------------------------------------------------------------ *
 * Minimal CDP client
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.method) {
        this.#handlers.get(msg.method)?.(msg.params);
        return;
      }
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.#pending.values()) {
        waiter.reject(new Error("CDP socket closed"));
      }
      this.#pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  /** Subscribe to a CDP event. One handler per method is all this needs. */
  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  /**
   * Every call is bounded. Chrome can simply stop answering — a blocked main
   * thread, a modal dialog, a crashed renderer — and an unbounded `await` here
   * parks the poll loop forever, past its own deadline, which is exactly how
   * the first version of this script hung.
   */
  send(method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (fn) => (arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      this.#pending.set(id, { resolve: settle(res), reject: settle(rej) });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate in the page's default context. Deliberately no `contextId`: the
   * sweep reloads on a fatal render, and pinning a context would leave us
   * talking to a realm that no longer exists.
   *
   * The inner `timeout` is Chrome's own execution cap, so a script that spins
   * gets aborted at the source rather than leaving us to guess from out here.
   */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
      timeout: EVALUATE_TIMEOUT_MS,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "evaluate threw");
    }
    return result.result?.value;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Chrome writes the port it actually bound to into `DevToolsActivePort`, which
 * is why we launch with `--remote-debugging-port=0`: a fixed port collides with
 * whatever else the runner (or the developer's machine) has open.
 */
async function readDevToolsPort(profileDir, deadlineMs = 30_000) {
  const file = join(profileDir, "DevToolsActivePort");
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").split("\n");
      if (port?.trim()) return Number(port.trim());
    }
    await sleep(200);
  }
  throw new Error("Chrome never reported a DevTools port");
}

async function openPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("Chrome exposed no page target");
  return page.webSocketDebuggerUrl;
}

/**
 * Push the sweep tab into the background by opening a throwaway tab in front
 * of it.
 *
 * This is not a trick, it is the harness's designed operating mode: it assumes
 * "an automation driver usually leaves the page hidden" and schedules its own
 * waits through `MessageChannel` because of it. `--headless=new` breaks that
 * assumption — a lone headless tab reports `document.hidden === false`.
 *
 * The cost of getting this wrong is not subtle. A visible tab means
 * `collectors.ts` stops discarding "ResizeObserver loop completed with
 * undelivered notifications", which the dev server produces in bursts whenever
 * a module load stretches a frame: the first green-in-substance run of this
 * script collected 1991 of them and nothing else. Suppressing that message in
 * the driver would have been the wrong fix — in a genuinely visible window it
 * means a real layout loop, and the harness is right to keep reporting it
 * there. So we make the tab honestly hidden and let the harness decide.
 */
async function backgroundTheSweepTab(port) {
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

async function runSweep(layout) {
  const chromeBin = findChrome();
  const profile = await mkdtemp(join(tmpdir(), "lantern-smoke-"));
  const args = [
    "--headless=new",
    `--window-size=${layout.window}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Shared memory in a container defaults to 64MB, which Chrome outgrows and
    // then dies mid-sweep with a tab crash that looks like an app fault.
    "--disable-dev-shm-usage",
    ...(process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ];

  console.log(`· launching ${chromeBin}`);
  const chrome = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let chromeStderr = "";
  chrome.stderr.on("data", (d) => (chromeStderr += d));

  let cdp = null;
  try {
    const port = await readDevToolsPort(profile);
    cdp = await Cdp.connect(await openPageTarget(port));

    // A `window.confirm` anywhere in the app blocks Runtime.evaluate until it
    // is answered, which from out here is indistinguishable from a hang.
    await cdp.send("Page.enable");
    cdp.on("Page.javascriptDialogOpening", () => {
      cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    });

    // Before navigating, so the collectors are installed in an already-hidden
    // document rather than seeing the boot frames as visible.
    await backgroundTheSweepTab(port);

    await cdp.send("Page.navigate", { url: `${ORIGIN}/?smoke=1` });

    // Assert it rather than assume it. If a future Chrome stops honouring tab
    // visibility in headless, the symptom is thousands of ResizeObserver
    // faults and a red build with no obvious cause — so say it here instead.
    const hidden = await cdp.evaluate("document.hidden === true");
    if (!hidden) {
      console.warn(
        "! the sweep tab is visible; expect ResizeObserver noise.\n" +
          "  See backgroundTheSweepTab() — the throwaway foreground tab did not take.",
      );
    }
    // Which layout rendered is not cosmetic — it decides which half of the app
    // gets swept at all. Ask the page the same question `useIsNarrow` asks, and
    // refuse to sweep the wrong one: a silently mismatched viewport is exactly
    // how this gate spent its first day covering desktop in CI and mobile
    // locally while reporting "PASSED" for both.
    const { width, height, narrow } = await cdp.evaluate(
      "({ width: innerWidth, height: innerHeight," +
        " narrow: !matchMedia('(min-width: 48rem)').matches })",
    );
    if (narrow !== layout.wantsNarrow) {
      throw new Error(
        `${layout.name}: asked for ${layout.window} but the page rendered the ` +
          `${narrow ? "narrow" : "desktop"} layout at ${width}x${height}`,
      );
    }
    console.log(
      `· sweeping ${layout.name} (${width}x${height}, tab hidden: ${hidden}) …`,
    );

    const startedAt = Date.now();
    let lastStep = null;
    let lastStepChangeAt = Date.now();
    let lastHeartbeatAt = Date.now();

    for (;;) {
      await sleep(POLL_INTERVAL_MS);

      if (chrome.exitCode !== null) {
        throw new Error(
          `Chrome exited (code ${chrome.exitCode}) before the sweep finished\n` +
            chromeStderr.slice(-2000),
        );
      }
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
        throw new Error(`sweep did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`);
      }

      // A reload between poll and evaluate makes this throw; that is normal
      // mid-sweep, so a failed probe just means "ask again".
      let done = false;
      let step = null;
      try {
        done = await cdp.evaluate("window.__SMOKE_DONE__ === true");
        step = await cdp.evaluate("JSON.stringify(window.__SMOKE_STEP__ ?? null)");
      } catch {
        continue;
      }

      if (Date.now() - lastHeartbeatAt > HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        const what = step ? (JSON.parse(step)?.what ?? "?") : "(no step yet)";
        console.log(`  … ${((Date.now() - startedAt) / 1000).toFixed(0)}s  ${what}`);
      }

      if (step !== lastStep) {
        lastStep = step;
        lastStepChangeAt = Date.now();
      } else if (!done && Date.now() - lastStepChangeAt > STUCK_TIMEOUT_MS) {
        const what = step ? JSON.parse(step)?.what : "(never started)";
        throw new Error(
          `sweep wedged for ${STUCK_TIMEOUT_MS / 1000}s at: ${what}\n` +
            `The liveness stamp window.__SMOKE_STEP__ stopped advancing.`,
        );
      }

      if (done) break;
    }

    const raw = await cdp.evaluate("JSON.stringify(window.__SMOKE__ ?? null)");
    if (!raw) throw new Error("sweep reported done but left no window.__SMOKE__");
    return JSON.parse(raw);
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    // SIGKILL is not synchronous. Deleting the profile while Chrome is still
    // flushing it races the writes and `rmSync` fails with ENOTEMPTY even under
    // `recursive`/`force` — which, thrown from a `finally`, replaces whatever
    // the sweep was actually reporting. That is exactly how the first CI run
    // failed: a finished sweep, reported as a driver crash, no report written.
    await once(chrome, "exit", EXIT_GRACE_MS);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      // A leftover temp directory is not worth failing a build over.
      console.warn(`! could not remove ${profile}: ${error.message}`);
    }
  }
}

/** Resolve on the named event, or after `timeoutMs` regardless. Never rejects. */
function once(emitter, event, timeoutMs) {
  return new Promise((res) => {
    const timer = setTimeout(res, timeoutMs);
    emitter.once(event, () => {
      clearTimeout(timer);
      res();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function summarize(report) {
  console.log("");
  console.log(
    `  routes visited   ${report.visited.length}` +
      (report.visited.length ? `  (${report.visited.join(", ")})` : ""),
  );
  console.log(`  actions          ${report.actions}`);
  console.log(`  skipped          ${report.skipped.length}  (destructive controls)`);
  console.log(`  unstubbed cmds   ${report.unstubbedAll.length}  (harness gap, not app bugs)`);
  console.log(`  restarts         ${report.restarts}`);
  console.log(`  reader painted   ${report.readerRendered}`);
  console.log(`  duration         ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`  errors           ${report.errors.length}`);

  for (const note of report.notes) console.log(`  note: ${note}`);

  for (const error of report.errors) {
    console.log("");
    console.log(`  ✗ [${error.kind}]${error.fatal ? " FATAL" : ""} ${error.message}`);
    console.log(`      route: ${error.route ?? "?"}   element: ${error.element ?? "?"}`);
    if (error.stubsInFlight?.length) {
      // The harness's own advice: a `{}` where the real backend returns a
      // populated struct is a harness gap, and it looks exactly like an app bug.
      console.log(`      stubs in flight: ${error.stubsInFlight.join(", ")}`);
      console.log(`      ^ suspect the harness first — add a fixture, see harness/README.md`);
    }
    if (error.stack) {
      console.log(
        error.stack
          .split("\n")
          .slice(0, 6)
          .map((l) => `      ${l}`)
          .join("\n"),
      );
    }
  }
  console.log("");
}

/**
 * The gate. Deliberately narrower than `report.ok`, which is
 * `errors.length === 0` and therefore also trips on `console.warn`.
 *
 * A warning is worth printing and worth fixing, but failing CI on one means the
 * next person to add a legitimate `console.warn` gets a red build and learns to
 * route around this check. What must never merge is a thrown exception, a
 * rejected promise, a click that blew up, or a render that emptied the root —
 * those are the class this harness exists to catch.
 */
const FAILING_KINDS = new Set(["error", "unhandledrejection", "click-threw", "resource"]);

function gate(report) {
  const failures = report.errors.filter((e) => FAILING_KINDS.has(e.kind) || e.fatal);
  const warnings = report.errors.filter((e) => !failures.includes(e));
  return { failures, warnings };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const keep = process.argv.includes("--keep");
// `--layout=narrow` while debugging one surface: a full pass is three minutes,
// and half of it is spent re-proving the layout that already works. CI passes
// no flag and still runs both.
const only = process.argv.find((arg) => arg.startsWith("--layout="))?.slice("--layout=".length);
const layouts = only ? LAYOUTS.filter((l) => l.name === only) : LAYOUTS;
if (!layouts.length) {
  console.error(`unknown layout "${only}" — expected one of ${LAYOUTS.map((l) => l.name).join(", ")}`);
  process.exit(2);
}
let harness = null;
let exitCode = 0;

try {
  harness = await ensureHarness();
  mkdirSync(dirname(reportPath(LAYOUTS[0])), { recursive: true });

  // Sequential, not parallel: two Chromes sweeping one dev server would race
  // for it, and the sweep's own timing budgets are tuned for an idle machine.
  for (const layout of layouts) {
    const report = await runSweep(layout);
    summarize(report);

    const path = reportPath(layout);
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`· full ${layout.name} report written to ${path.replace(`${root}/`, "")}`);

    const { failures, warnings } = gate(report);
    if (warnings.length) {
      console.log(`· ${warnings.length} console warning(s) recorded, not failing the build`);
    }
    if (failures.length) {
      console.error(`\n✗ ${layout.name} FAILED — ${failures.length} error(s) that must not merge`);
      exitCode = 1;
    } else if (!report.visited.length) {
      // A sweep that reached nothing is green for the wrong reason.
      console.error(`\n✗ ${layout.name} FAILED — the sweep visited no routes at all`);
      exitCode = 1;
    } else {
      console.log(`✓ ${layout.name} PASSED`);
    }
    console.log("");
  }

  // Both layouts ran, so say so once — a single "PASSED" above could otherwise
  // be read as the whole gate having passed.
  if (!exitCode) console.log(`✓ smoke PASSED (${layouts.map((l) => l.name).join(" + ")})`);
} catch (error) {
  console.error(`\n✗ smoke driver failed: ${error instanceof Error ? error.message : error}`);
  exitCode = 1;
} finally {
  if (harness && !keep) stopHarness(harness);
  else if (harness) console.log(`· harness left running on ${ORIGIN} (--keep)`);
}

process.exit(exitCode);
