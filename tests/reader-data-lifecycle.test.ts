import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import type { useHighlights } from "../src/hooks/useBookmarks.ts";
import type { ReadingProgressWriter } from "../src/pages/reader/reading-progress-writer.ts";

const bundles = await Promise.all([
  "src/hooks/useBookmarks.ts", "src/pages/reader/reading-progress-writer.ts",
].map((entry) => build({
  entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "boundaries", setup(builder) {
    builder.onResolve({ filter: /^(react|@tauri-apps\/api\/core)$|useBooks$/ }, ({ path }) => ({ path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: path === "react"
      ? "export const {useState,useRef,useCallback,useMemo,useEffect} = globalThis.host;"
      : path.includes("useBooks") ? "export const updateReadingProgress = (...args) => globalThis.host.write(...args);"
        : "export const invoke = globalThis.host.invoke;" }));
  } }],
})));

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function highlightsHost() {
  const slots: any[] = [];
  const pending: (() => void)[] = [];
  const effects: (() => void)[] = [];
  const events = new EventTarget();
  const requests: { bookId: string; result: ReturnType<typeof deferred<any[]>> }[] = [];
  let cursor = 0;
  function memo(value: any, deps: any[]) {
    const index = cursor++;
    const old = slots[index];
    const changed = !old || deps.some((dep, i) => !Object.is(dep, old.deps[i]));
    if (changed) slots[index] = { ...old, value, deps };
    return { index, changed, value: slots[index].value };
  }
  const host = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => pending.push(() => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
      })];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: (fn: any, deps: any[]) => memo(fn, deps).value,
    useMemo: (fn: () => any, deps: any[]) => { const slot = memo(null, deps); if (slot.changed) slots[slot.index].value = fn(); return slots[slot.index].value; },
    useEffect(fn: () => any, deps: any[]) {
      const { index, changed } = memo(fn, deps);
      if (changed) effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); });
    },
    invoke(_command: string, { bookId }: { bookId: string }) {
      const result = deferred<any[]>(); requests.push({ bookId, result }); return result.promise;
    },
  };
  const module = { exports: {} as { useHighlights: typeof useHighlights } };
  runInNewContext(bundles[0].outputFiles[0].text, { module, exports: module.exports, host, window: events, console });
  const render = (bookId = "A", commitEffects = true) => {
    pending.splice(0).forEach((update) => update()); cursor = 0;
    const value = module.exports.useHighlights(bookId);
    if (commitEffects) effects.splice(0).forEach((effect) => effect());
    return value;
  };
  const emit = (bookId: string) => {
    const event = new Event("highlight-changed"); Object.assign(event, { detail: { bookId } }); events.dispatchEvent(event);
  };
  return { requests, render, emit };
}

test("every mounted highlight consumer refreshes only the changed book", async () => {
  const h = highlightsHost(); h.render();
  h.requests[0].result.resolve([{ id: "old" }]); await settle();
  h.emit("B"); assert.equal(h.requests.length, 1);
  h.emit("A"); assert.equal(h.requests.length, 2);
  h.requests[1].result.resolve([{ id: "new" }]); await settle();
  assert.equal(h.render().highlights[0].id, "new");
});

test("highlight refresh ignores superseded responses and hides the old book before effects", async () => {
  const h = highlightsHost(); const first = h.render();
  h.requests[0].result.resolve([{ id: "A" }]); await settle(); h.render();
  assert.equal(h.render("B", false).highlights.length, 0);
  h.render("B"); await first.refresh();
  h.requests[1].result.resolve([{ id: "B" }]); await settle();
  assert.equal(h.render("B").highlights[0].id, "B");
});

test("newest highlight request wins when responses resolve backwards", async () => {
  const h = highlightsHost(); const hook = h.render();
  const refresh = hook.refresh();
  h.requests[1].result.resolve([{ id: "fresh" }]); await refresh;
  h.requests[0].result.resolve([{ id: "stale" }]); await settle();
  assert.equal(h.render().highlights[0].id, "fresh");
});

function writerHost() {
  const writes: any[][] = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  const host = { write: async (...args: any[]) => { writes.push(args); return false; } };
  const module = { exports: {} as { ReadingProgressWriter: typeof ReadingProgressWriter } };
  runInNewContext(bundles[1].outputFiles[0].text, {
    module, exports: module.exports, host,
    window: { setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id: number) { timers.delete(id); } },
  });
  return { writer: new module.exports.ReadingProgressWriter(), createWriter: () => new module.exports.ReadingProgressWriter(undefined, false), host, writes, timers,
    tick() { const entries = [...timers]; timers.clear(); entries.forEach(([, callback]) => callback()); },
  };
}

test("auto-save off retains latest location for exit and cancels a scheduled save", async () => {
  const h = writerHost(); h.writer.queue("A", 10, "old");
  h.writer.setAutoSave(false); h.writer.queue("A", 20, "latest"); h.tick(); await settle();
  assert.equal(h.writes.length, 0);
  await h.writer.flush(); assert.deepEqual(h.writes[0], ["A", 20, "latest"]);
});

test("auto-save resumes pending progress and book sessions flush to their original identity", async () => {
  const a = writerHost(); const b = writerHost();
  a.writer.setAutoSave(false); a.writer.queue("A", 20, "A-exit");
  b.writer.queue("B", 30, "B-current"); await a.writer.flush();
  assert.deepEqual(a.writes[0], ["A", 20, "A-exit"]);
  b.writer.setAutoSave(false); b.writer.setAutoSave(true); b.tick(); await settle();
  assert.deepEqual(b.writes[0], ["B", 30, "B-current"]);
});



test("exit flush reports write failure and retains progress for retry", async () => {
  const timers = new Map<number, () => void>(); let fail = true; const writes: any[][] = [];
  const module = { exports: {} as { ReadingProgressWriter: typeof ReadingProgressWriter } };
  runInNewContext(bundles[1].outputFiles[0].text, { module, exports: module.exports,
    host: { async write(...args: any[]) { writes.push(args); if (fail) throw new Error("disk failure"); return false; } },
    window: { setTimeout(fn: () => void) { timers.set(1, fn); return 1; }, clearTimeout(id: number) { timers.delete(id); } },
  });
  const writer = new module.exports.ReadingProgressWriter(undefined, false);
  writer.queue("A", 30, "latest"); assert.equal(await writer.flush(), false);
  fail = false; assert.equal(await writer.flush(), true);
  assert.deepEqual(writes, [["A", 30, "latest"], ["A", 30, "latest"]]);
});

test("exit drains positions queued during an existing write while auto-save is off", async () => {
  const write = deferred<boolean>(); const writes: any[][] = []; let count = 0;
  const module = { exports: {} as { ReadingProgressWriter: typeof ReadingProgressWriter } };
  runInNewContext(bundles[1].outputFiles[0].text, { module, exports: module.exports,
    host: { async write(...args: any[]) { writes.push(args); return ++count === 1 ? write.promise : false; } },
    window: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  const writer = new module.exports.ReadingProgressWriter(undefined, false);
  writer.queue("A", 10, "old"); const first = writer.flush();
  writer.queue("A", 20, "latest"); const exit = writer.flush();
  write.resolve(false); assert.equal(await exit, true); await first;
  assert.deepEqual(writes, [["A", 10, "old"], ["A", 20, "latest"]]);
});


test("same-book replacement waits behind an older in-flight write", async () => {
  const h = writerHost(); const oldWrite = deferred<boolean>(); let count = 0;
  h.host.write = async (...args: any[]) => {
    h.writes.push(args);
    return ++count === 1 ? oldWrite.promise : false;
  };
  const oldSession = h.createWriter(); const newSession = h.createWriter();
  oldSession.queue("A", 10, "old"); const oldSave = oldSession.flush();
  newSession.queue("A", 40, "new"); const newSave = newSession.flush();
  assert.equal(h.writes.length, 1);
  oldWrite.resolve(false); await oldSave; await newSave;
  assert.deepEqual(h.writes, [["A", 10, "old"], ["A", 40, "new"]]);
});

test("failed obsolete session cannot overwrite a newer same-book position on retry", async () => {
  const h = writerHost(); let fail = true;
  h.host.write = async (...args: any[]) => {
    h.writes.push(args);
    if (fail) throw new Error("disk failure");
    return false;
  };
  const oldSession = h.createWriter(); const newSession = h.createWriter();
  oldSession.queue("A", 10, "old"); assert.equal(await oldSession.flush(), false);
  newSession.queue("A", 40, "new"); fail = false;
  assert.equal(await newSession.flush(), true);
  assert.equal(await oldSession.flush(), true);
  assert.equal(oldSession.hasPending(), false);
  assert.deepEqual(h.writes, [["A", 10, "old"], ["A", 40, "new"]]);
});
