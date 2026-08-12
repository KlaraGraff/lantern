/**
 * The in-page sweep runner.
 *
 * Loaded by `harness/entry.ts` when the URL carries `?smoke=1`. It walks every
 * route, opens what it can reach, clicks what is safe to click, and leaves a
 * report on `window.__SMOKE__`.
 *
 * ── REPORT CONTRACT ────────────────────────────────────────────────────────
 * The driver (a browser automation session, or a human in devtools) reads
 * `window.__SMOKE__`. Keep this shape stable:
 *
 *   {
 *     ok:        boolean            // no errors collected
 *     done:      boolean            // sweep finished (false while running)
 *     visited:   string[]           // routes actually rendered, in order
 *     actions:   number             // clicks/toggles actually performed
 *     skipped:   Array<{ route, element, reason }>
 *     unstubbed: string[]           // invoke commands answered by the default
 *                                   // stub — a harness gap, NOT an app bug
 *     errors:    Array<{
 *                  route, element, kind, message, stack,
 *                  stubsInFlight: string[],  // default-stubbed commands that
 *                                            // were in flight — non-empty means
 *                                            // suspect the harness first
 *                  fatal: boolean            // this one emptied the React root
 *                }>
 *     // Extras, informational; safe to ignore but also safe to rely on:
 *     rejectedByHarness: string[]   // commands the harness failed on purpose
 *     durationMs: number
 *     errorBoundary: string | null  // React error-boundary signal, if any
 *     readerRendered: boolean       // did a real book paint in the reader
 *     notes: string[]
 *     restarts:  number             // fatal renders the sweep reloaded through
 *     unstubbedAll: string[]        // `unstubbed`, accumulated across restarts
 *   }
 *
 * `window.__SMOKE_DONE__` flips to `true` at the same moment as `done`, for
 * drivers that prefer polling one boolean. A driver must poll it rather than
 * awaiting a promise: a fatal render reloads the page, and the sweep resumes in
 * a fresh JS realm where the old promise no longer exists.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { context, getFaults, hiddenTabResizeNoiseCount, type Fault } from "./collectors";
import { BOOKS } from "./fixture-data";
import { harness } from "./state";
import { sleep } from "./task";

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

const MAX_ACTIONS_PER_SCOPE = 120;
const MAX_DEPTH = 3;
/**
 * How many times one opener may be clicked again after the scope it opened
 * closed itself. The narrow layout's library drawer closes on every row click,
 * so its whole menu costs one re-open per row.
 */
const MAX_SCOPE_REOPENS = 24;
const SETTLE_QUIET_MS = 60;
const SETTLE_MAX_MS = 600;
const READER_SETTLE_MAX_MS = 12_000;
/** Hard ceiling, so a pathological page can never hang the driver. */
const TOTAL_BUDGET_MS = 15 * 60_000;

let deadlineAt = Number.POSITIVE_INFINITY;
const outOfTime = () => Date.now() > deadlineAt;

/**
 * Accessible names that must never be clicked. A sweep that empties the
 * library mid-run produces a report about an empty library.
 *
 * Both languages, because the harness may be swept with `language: "zh"` and
 * because the app ships zh strings that a future default could switch to.
 */
const DESTRUCTIVE =
  /(^|\b)(delete|remove|clear|reset|uninstall|erase|wipe|revoke|forget|discard|log ?out|sign ?out|restore defaults?)(\b|$)|删除|移除|清除|清空|重置|卸载|退出|注销|恢复默认|放弃/i;

/** Clicked last within a scope: they close the thing being swept. */
const CLOSING = /(^|\b)(close|back|cancel|done|dismiss)(\b|$)|关闭|返回|取消|完成|忽略/i;

/** Never followed: they leave the harness. */
const EXTERNAL = /^(https?:|mailto:|tel:)/i;

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export interface SmokeSkip {
  route: string;
  element: string;
  reason: string;
}

export interface SmokeError {
  route: string | null;
  element: string | null;
  kind: string;
  message: string;
  stack: string | null;
  /**
   * Commands answered by the shape-guessed default stub while this happened.
   * Non-empty = suspect the harness first: the component probably dereferenced
   * a field of a `{}` the real backend would have filled in.
   */
  stubsInFlight: string[];
  /** The React root emptied — this error took the whole window down. */
  fatal: boolean;
}

export interface SmokeReport {
  ok: boolean;
  done: boolean;
  visited: string[];
  actions: number;
  skipped: SmokeSkip[];
  unstubbed: string[];
  errors: SmokeError[];
  rejectedByHarness: string[];
  durationMs: number;
  errorBoundary: string | null;
  readerRendered: boolean;
  notes: string[];
  /** How many times a fatal render forced the sweep to reload and resume. */
  restarts: number;
  /** Every command the default stub answered, across restarts. */
  unstubbedAll: string[];
}

declare global {
  interface Window {
    __SMOKE__?: SmokeReport;
    __SMOKE_DONE__?: boolean;
    /** Liveness probe: the last action started, and when. */
    __SMOKE_STEP__?: { at: number; what: string };
  }
}

/* ------------------------------------------------------------------ *
 * Crash recovery
 *
 * The app has no React error boundary, so one throwing component empties the
 * whole root and every later click hits a blank page. Without recovery the
 * sweep silently reports "5 actions, 1 error" and looks like it worked.
 *
 * So: when the root empties, the sweep saves its progress to `sessionStorage`,
 * marks the offending control as poisoned, and reloads. The next boot resumes
 * where it left off and never clicks that control again.
 * ------------------------------------------------------------------ */

const RESUME_KEY = "__lantern_smoke_resume__";
const MAX_RESTARTS = 12;

/**
 * The query string as it was at boot, captured before the sweep's first
 * `pushState` throws it away. A restart has to put `?empty=1`, `?lang=zh` and
 * friends back or it resumes against a different app.
 */
const bootSearch = location.search;

interface ResumeState {
  visited: string[];
  actions: number;
  skipped: SmokeSkip[];
  errors: SmokeError[];
  notes: string[];
  readerRendered: boolean;
  /** `${route} ${key}` already acted on — never repeated after a resume. */
  completed: string[];
  /** Controls that emptied the React root. Skipped, and reported. */
  poisoned: string[];
  restarts: number;
  startedAt: number;
  /** Default-stubbed commands seen so far; a reload resets the mock's own set. */
  unstubbedAll: string[];
}

function loadResume(): ResumeState | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    return raw ? (JSON.parse(raw) as ResumeState) : null;
  } catch {
    return null;
  }
}

function saveResume(state: ResumeState): void {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the sweep degrades to "stops at the first
    // fatal", which is what it did before recovery existed.
  }
}

function clearResume(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* nothing to do */
  }
}

const resumed = loadResume();

const completed = new Set<string>(resumed?.completed ?? []);
const poisoned = new Set<string>(resumed?.poisoned ?? []);
let restarts = resumed?.restarts ?? 0;
const startedAt = resumed?.startedAt ?? Date.now();

const report: SmokeReport = {
  ok: false,
  done: false,
  visited: resumed?.visited ?? [],
  actions: resumed?.actions ?? 0,
  skipped: resumed?.skipped ?? [],
  unstubbed: [],
  errors: resumed?.errors ?? [],
  rejectedByHarness: [],
  durationMs: 0,
  errorBoundary: null,
  readerRendered: resumed?.readerRendered ?? false,
  notes: resumed?.notes ?? [],
  restarts,
  unstubbedAll: resumed?.unstubbedAll ?? [],
};

window.__SMOKE__ = report;
window.__SMOKE_DONE__ = false;

/** The React root is empty — a render threw and took the app down with it. */
function rootIsDead(): boolean {
  const root = document.getElementById("root");
  return !!root && root.childElementCount === 0;
}

function snapshot(): ResumeState {
  return {
    visited: report.visited,
    actions: report.actions,
    skipped: report.skipped,
    errors: report.errors,
    notes: report.notes,
    readerRendered: report.readerRendered,
    completed: [...completed],
    poisoned: [...poisoned],
    restarts,
    startedAt,
    unstubbedAll: [...new Set([...report.unstubbedAll, ...harness.unstubbed])].sort(),
  };
}

/**
 * Persist progress and reload. Never returns.
 *
 * Reloads to `/?smoke=1` rather than calling `location.reload()`: the sweep
 * navigates with `history.pushState`, which has long since dropped the query
 * string, and a reload of the bare URL comes back with the sweep switched off —
 * looking exactly like a hang.
 */
function restartAfterCrash(reason: string): never {
  restarts += 1;
  report.notes.push(`restart ${restarts}: ${reason}`);
  saveResume(snapshot());
  const params = new URLSearchParams(bootSearch);
  params.set("smoke", "1");
  location.replace(`/?${params.toString()}`);
  // `location.replace()` does not stop synchronous execution; this does.
  throw new Error("__smoke_restart__");
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/* `sleep` comes from `./task` — see there for why it is not `setTimeout`. */

/**
 * One paint, or 50ms — whichever comes first. The race matters: a backgrounded
 * or hidden tab throttles `requestAnimationFrame` to zero, and a bare `await
 * frame()` then hangs the whole sweep forever. That is not hypothetical; it is
 * how the first run of this harness died.
 */
const frame = () =>
  new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    void sleep(50).then(finish);
  });

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 80);
  const name = el.getAttribute("name") ?? el.getAttribute("data-testid") ?? "";
  return name || `<${el.tagName.toLowerCase()}>`;
}

function describe(el: Element): string {
  const role = el.getAttribute("role");
  const tag = el.tagName.toLowerCase();
  return `${tag}${role ? `[role=${role}]` : ""} "${accessibleName(el)}"`;
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  if (el.closest("[aria-hidden='true']")) return false;
  if (el.closest("[inert]")) return false;
  return true;
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  return false;
}

const TARGET_SELECTOR = [
  "button",
  "[role=button]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=radio]",
  "[role=option]",
  "input[type=checkbox]",
  "input[type=radio]",
  "a[href]",
  "summary",
].join(",");

interface Target {
  el: Element;
  /** Stable-enough identity so a re-scan does not re-click the same control. */
  key: string;
  /**
   * Identity without the DOM index — used for poisoning. A control that killed
   * the app on one route will kill it on every other route it appears on, and
   * the settings modal appears on all of them.
   */
  id: string;
  name: string;
}

/**
 * Every actionable control inside `scope`, keyed. The index is computed once
 * over the whole scan rather than per element — an `indexOf` inside a
 * per-element key function turns each pass into an O(n²) DOM walk, which on the
 * settings modal alone was costing whole seconds per click.
 */
function collectTargets(scope: ParentNode): Target[] {
  const found = Array.from(scope.querySelectorAll(TARGET_SELECTOR));
  const targets: Target[] = [];
  found.forEach((el, index) => {
    if (!isVisible(el) || isDisabled(el)) return;
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!href || href === "#" || EXTERNAL.test(href)) return;
      if (el.getAttribute("target") === "_blank") return;
    }
    const name = accessibleName(el);
    const id = `${el.tagName.toLowerCase()}|${el.getAttribute("role") ?? ""}|${name}`;
    targets.push({ el, name, id, key: `${id}|${index}` });
  });
  // Closing controls last, so the scope stays open while it is being swept.
  return targets.sort((a, b) => Number(CLOSING.test(a.name)) - Number(CLOSING.test(b.name)));
}

function openDialogs(): Element[] {
  return Array.from(document.querySelectorAll("[role=dialog],[aria-modal='true'],dialog[open]"))
    .filter(isVisible);
}

/* ------------------------------------------------------------------ *
 * Waiting
 * ------------------------------------------------------------------ */

/** Settle = two frames, then quiet on the invoke bus, capped. */
async function settle(maxMs = SETTLE_MAX_MS): Promise<void> {
  await frame();
  await frame();
  const deadline = Date.now() + maxMs;
  let lastCall = harness.calls.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(20);
    if (harness.calls.length !== lastCall) {
      lastCall = harness.calls.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= SETTLE_QUIET_MS) return;
  }
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

async function goto(path: string): Promise<void> {
  if (location.pathname + location.search === path) return;
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  context.route = path;
  await settle();
}

const routePath = () => location.pathname + location.search;

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

function skip(element: string, reason: string): void {
  report.skipped.push({ route: context.route ?? routePath(), element, reason });
}

/**
 * Move everything the collectors have gathered since the last harvest into the
 * report. Done incrementally rather than once at the end, because a reload
 * throws the collectors' buffer away and the report has to survive it.
 */
let harvested = 0;
function harvestFaults(fatal: boolean): void {
  const faults: Fault[] = getFaults();
  for (; harvested < faults.length; harvested++) {
    const fault = faults[harvested];
    report.errors.push({
      route: fault.route,
      element: fault.action,
      kind: fault.kind,
      message: fault.message,
      stack: fault.stack,
      stubsInFlight: [...new Set(fault.stubsInFlight)],
      fatal,
    });
  }
}

async function press(key: string): Promise<void> {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", init));
  document.dispatchEvent(new KeyboardEvent("keyup", init));
  await frame();
}

/** Put the page back the way it was, so the next failure stays attributable. */
async function restore(baseRoute: string, dialogsBefore: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (openDialogs().length <= dialogsBefore) break;
    await press("Escape");
    await sleep(40);
    if (openDialogs().length <= dialogsBefore) break;
    // Escape refused: click the topmost close affordance instead.
    const dialogs = openDialogs();
    const top = dialogs[dialogs.length - 1];
    const closer = collectTargets(top).find((t) => CLOSING.test(t.name));
    if (!closer) break;
    (closer.el as HTMLElement).click();
    await sleep(60);
  }
  if (routePath() !== baseRoute) await goto(baseRoute);
}

/**
 * Perform one action. Returns `false` when the action was skipped.
 *
 * Throws `__smoke_restart__` (via `restartAfterCrash`) if the click emptied the
 * React root — the caller must not swallow that.
 */
async function act(target: Target, route: string): Promise<boolean> {
  const { el, name } = target;
  const stamp = `${route} ${target.key}`;

  if (DESTRUCTIVE.test(name)) {
    skip(describe(el), "destructive accessible name");
    completed.add(stamp);
    return false;
  }
  if (poisoned.has(target.id)) {
    skip(describe(el), "poisoned: emptied the React root on an earlier pass");
    completed.add(stamp);
    return false;
  }

  context.action = describe(el);
  harness.stubsSinceMark.length = 0;
  report.actions++;
  completed.add(stamp);
  // Liveness probe for whoever is driving: if this stops moving, the sweep is
  // wedged rather than merely slow.
  window.__SMOKE_STEP__ = { at: Date.now(), what: `${route} :: ${context.action}` };

  try {
    (el as HTMLElement).focus?.();
    (el as HTMLElement).click();
  } catch (error) {
    // A throw straight out of click() is a real app bug; the collectors do not
    // see it, because it never reaches the event loop.
    report.errors.push({
      route: context.route,
      element: context.action,
      kind: "click-threw",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
      stubsInFlight: [...new Set(harness.stubsSinceMark)],
      fatal: false,
    });
  }
  await settle();

  if (rootIsDead()) {
    poisoned.add(target.id);
    harvestFaults(true);
    if (restarts >= MAX_RESTARTS) {
      report.notes.push("restart cap reached; sweep stopped early");
      throw new Error("__smoke_give_up__");
    }
    restartAfterCrash(`fatal render after ${context.action} on ${route}`);
  }
  return true;
}

/**
 * Returns `true` when the scope has nothing left worth clicking, and `false`
 * when it went empty *without* being swept — see the re-open loop below.
 */
async function sweepScope(scope: ParentNode, depth: number, baseRoute: string): Promise<boolean> {
  const seen = new Set<string>();
  const startingTargets = collectTargets(scope).length;
  // A scope that empties out after fewer clicks than it started with did not
  // run out of targets, it stopped offering them — it closed under us.
  const collapsed = () => collectTargets(scope).length === 0 && seen.size < startingTargets;

  for (let guard = 0; guard < MAX_ACTIONS_PER_SCOPE; guard++) {
    if (outOfTime()) {
      report.notes.push(`time budget exhausted during ${baseRoute} (depth ${depth})`);
      return true;
    }
    if (scope !== document && !(scope as Element).isConnected) return !collapsed();
    const target = collectTargets(scope).find(
      (t) => !seen.has(t.key) && !completed.has(`${baseRoute} ${t.key}`),
    );
    if (!target) return !collapsed();
    seen.add(target.key);

    const dialogsBefore = openDialogs().length;
    const acted = await act(target, baseRoute);
    harvestFaults(false);
    if (!acted) continue;

    // Anything that just appeared gets swept one level deeper, then closed.
    const after = openDialogs();
    if (after.length > dialogsBefore && depth < MAX_DEPTH) {
      let opened = after[after.length - 1];
      // A control inside a drawer or a modal is allowed to close the thing it
      // lives in, and the narrow layout's library drawer does exactly that on
      // every sidebar row click. One descent therefore buys exactly one row:
      // the drawer goes `inert`, the next `collectTargets` finds nothing, and
      // the sweep leaves for good, because its opener is already in
      // `completed` and will never fire again. That is how Notes, Words, Q&A
      // and Reading history went unvisited in every narrow run. So re-open and
      // carry on. `completed` is what makes this terminate: rows already
      // clicked stay clicked, so each pass either reaches a new one or reports
      // the scope exhausted.
      for (let reopen = 0; ; reopen++) {
        const actionsBefore = report.actions;
        if (await sweepScope(opened, depth + 1, baseRoute)) break;
        if (reopen >= MAX_SCOPE_REOPENS || report.actions === actionsBefore) {
          report.notes.push(
            `scope re-open budget spent at depth ${depth + 1} on ${baseRoute} (${target.name})`,
          );
          break;
        }
        await restore(baseRoute, dialogsBefore);
        // Re-found rather than re-used: whatever the drawer did on the way out
        // may have remounted the header the opener lives in, and the node
        // captured before the descent is then detached even though the button
        // is still on screen. Matched on `id` (tag, role, accessible name) and
        // not on `key`, because `key` carries the element's position in the
        // scope — and the page behind the drawer is exactly what just changed.
        const opener = collectTargets(scope).find((t) => t.id === target.id);
        if (!opener) break;
        (opener.el as HTMLElement).click();
        await settle();
        const reopened = openDialogs();
        if (reopened.length <= dialogsBefore) break;
        opened = reopened[reopened.length - 1];
      }
    }
    await restore(baseRoute, dialogsBefore);
    context.action = null;
  }
  report.notes.push(`scope action cap reached at depth ${depth} on ${baseRoute}`);
  return true;
}

/** The settings modal is opened by a documented DOM event, not by a button. */
async function sweepSettings(baseRoute: string): Promise<void> {
  // Close whatever the route sweep left open first: dispatching the event while
  // the modal is already up is a no-op, and the old code read that as "the
  // modal refused to open".
  await restore(baseRoute, 0);
  const before = openDialogs().length;
  let dialogs: Element[] = [];
  // Retried: the modal fades in, and a settle that ends while it is still at
  // opacity 0 reads as "it never opened".
  for (let attempt = 0; attempt < 3 && dialogs.length <= before; attempt++) {
    window.dispatchEvent(new CustomEvent("open-settings", { detail: "root" }));
    await settle();
    await sleep(250);
    dialogs = openDialogs();
  }
  if (dialogs.length <= before) {
    report.notes.push(
      `settings modal did not open from the open-settings event on ${baseRoute}` +
        ` (open dialogs: ${openDialogs().map(accessibleName).join(", ") || "none"})`,
    );
    return;
  }
  context.route = `${baseRoute}#settings`;
  await sweepScope(dialogs[dialogs.length - 1], 1, baseRoute);
  await restore(baseRoute, before);
  context.route = baseRoute;
}

interface FoliateView extends Element {
  book?: unknown;
  renderer?: { getContents?: () => Array<{ doc?: Document }> };
}

/**
 * Did a real book paint?
 *
 * Detection goes through `renderer.getContents()` rather than the DOM: the
 * foliate paginator attaches its shadow root with `mode: "closed"`, so its
 * iframe is genuinely unreachable from outside — there is no selector that
 * finds it.
 *
 * Returns a verdict rather than a bare boolean, because "the book never loaded"
 * and "the book loaded but the browser refused to lay it out" are different
 * facts and only one of them is about the app.
 */
async function waitForReader(): Promise<{ painted: boolean; note: string }> {
  const deadline = Date.now() + READER_SETTLE_MAX_MS;
  let loaded = false;
  while (Date.now() < deadline) {
    const view = document.querySelector("foliate-view") as FoliateView | null;
    if (view?.book) loaded = true;
    const contents = view?.renderer?.getContents?.() ?? [];
    const doc = contents[0]?.doc;
    if (doc && (doc.body?.textContent ?? "").trim().length > 0) {
      return { painted: true, note: "reader: book content painted through foliate-js" };
    }
    await sleep(200);
  }
  if (loaded && document.hidden) {
    return {
      painted: false,
      note:
        "reader: foliate opened the book but painted nothing — document.hidden is true, " +
        "and the paginator lays out on ResizeObserver/rAF, which browsers do not run for " +
        "hidden documents. Not an app fault; run the sweep in a visible window to cover it.",
    };
  }
  return {
    painted: false,
    note: loaded
      ? "reader: foliate opened the book but painted no content (see errors)"
      : "reader: foliate never opened the book (see errors)",
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/** Every route the sweep walks, in order. */
function routes(): string[] {
  return [
    "/",
    `/book/${BOOKS[0].id}`,
    `/book/${BOOKS[2].id}`, // the unavailable one: missing-file branch
    `/reader/${BOOKS[0].id}`,
    `/reader/${BOOKS[2].id}`, // PDF, and the file is missing: error branch
    `/reader/${BOOKS[3].id}`, // plain text: TextBookReader, no foliate at all
  ];
}

export async function runSmoke(): Promise<SmokeReport> {
  deadlineAt = startedAt + TOTAL_BUDGET_MS;
  context.probeStubs = () => [...new Set(harness.stubsSinceMark)];
  console.info(
    `[harness] smoke sweep ${restarts > 0 ? `resuming (restart ${restarts})` : "starting"}`,
  );

  // Wait for the first paint of the library before touching anything.
  await settle(4000);
  harvestFaults(false);

  try {
    for (const route of routes()) {
      await goto(route);
      context.route = route;
      if (!report.visited.includes(route)) report.visited.push(route);

      if (route.startsWith("/reader/")) {
        // The text book renders in the host document — there is no
        // `foliate-view` for `waitForReader` to find, so asking it would only
        // spend the whole reader budget before reporting the obvious.
        if (route !== `/reader/${BOOKS[3].id}`) {
          const verdict = await waitForReader();
          if (route === `/reader/${BOOKS[0].id}`) {
            report.readerRendered = verdict.painted;
            if (!report.notes.includes(verdict.note)) report.notes.push(verdict.note);
          }
        }
        await settle(2000);
        harvestFaults(false);
      }

      await sweepScope(document, 0, route);
      await sweepSettings(route);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "__smoke_restart__") throw error;
    if (!(error instanceof Error && error.message === "__smoke_give_up__")) {
      report.notes.push(
        `sweep aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Back to the library so a human landing on the page afterwards sees it.
  await goto("/");
  harvestFaults(false);

  report.unstubbed = [...harness.unstubbed].sort();
  report.unstubbedAll = [...new Set([...report.unstubbedAll, ...report.unstubbed])].sort();
  report.rejectedByHarness = [...harness.rejected].sort();
  report.restarts = restarts;
  const resizeNoise = hiddenTabResizeNoiseCount();
  if (resizeNoise > 0) {
    report.notes.push(
      `${resizeNoise} "ResizeObserver loop" reports set aside: the document was ` +
        `hidden, so the browser had no frame in which to deliver them. Not an app ` +
        `fault — in a visible window they are collected as errors.`,
    );
  }
  report.durationMs = Date.now() - startedAt;
  // A fatal render is an app-visible failure even though the harness recovered
  // from it, so it counts against `ok` like any other error.
  report.ok = report.errors.length === 0;
  report.done = true;
  window.__SMOKE_DONE__ = true;
  clearResume();

  console.info(
    `[harness] smoke ${report.ok ? "PASS" : "FAIL"} — ` +
      `${report.visited.length} routes, ${report.actions} actions, ` +
      `${report.skipped.length} skipped, ${report.unstubbed.length} unstubbed, ` +
      `${report.errors.length} errors, ${report.restarts} restarts, ` +
      `reader=${report.readerRendered ? "rendered" : "blank"}, ${report.durationMs}ms`,
  );
  return report;
}
