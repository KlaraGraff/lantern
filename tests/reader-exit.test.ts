import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";

const bundle = await build({
  entryPoints: ["src/pages/reader/reader-exit.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "mock-ipc", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/|\/platform$|\/i18n$/ }, ({ path }) => ({ path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents:
      path.endsWith("/core") ? "export const invoke = host.invoke;" :
      path.endsWith("/event") ? "export const listen = host.listen;" :
      path.endsWith("/webviewWindow") ? "export const getCurrentWebviewWindow = () => host.appWindow;" :
      path.endsWith("/platform") ? "export const platform = {hasWindow: true};" :
      path.endsWith("/i18n") ? "export default {t: key => key};" :
      "export const message = host.message;",
    }));
  } }],
});
const writerBundle = await build({
  entryPoints: ["src/pages/reader/reading-progress-writer.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{name: "write-progress", setup(builder) {
    builder.onResolve({filter: /useBooks$/}, ({path}) => ({path, namespace: "mock"}));
    builder.onLoad({filter: /.*/, namespace: "mock"}, () => ({contents: "export const updateReadingProgress = (...args) => host.write(...args);"}));
  }}],
});
const readerSource = readFileSync("src/pages/Reader.tsx", "utf8");
const restoreStart = readerSource.indexOf("    flushBookProgress(bookId).then");
const restoreEnd = readerSource.indexOf("    const autoSaveRevision", restoreStart);
function restore(h: ReturnType<typeof harness>, readBook: () => Promise<any>) {
  let book: any; let error: any;
  const noop = () => {};
  const done = runInNewContext(`(async () => { await ${readerSource.slice(restoreStart, restoreEnd)} })()`, {
    flushBookProgress: h.flushBookProgress, bookId: "A", cancelled: false,
    getBook: readBook, setReaderError(value: any) {error = value;},
    t: (key: string) => key, currentCfiRef: {current: null}, setTextInitialLocation: noop,
    setBook(value: any) {book = value;}, isStandaloneWindow: false, setLoading: noop,
  });
  return {done, get book() {return book;}, get error() {return error;}};
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function harness(write = async (..._args: any[]): Promise<boolean> => false) {
  const events = new Map<string, (event: {payload: number}) => Promise<void>>();
  const calls: [string, any][] = [];
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  const window = new EventTarget();
  let closeHandler!: (event: {preventDefault: () => void}) => Promise<void>;
  let errors = 0;
  const host = {
    write,
    async invoke(name: string, args: any) { calls.push([name, args]); },
    async listen(name: string, handler: any) { events.set(name, handler); return () => events.delete(name); },
    appWindow: { async onCloseRequested(handler: typeof closeHandler) { closeHandler = handler; return () => {}; } },
    async message() { calls.push(["dialog", undefined]); },
  };
  const writerModule = {exports: {} as any};
  runInNewContext(writerBundle.outputFiles[0].text, {module: writerModule, exports: writerModule.exports, host, window});
  const module = {exports: {} as any};
  runInNewContext(bundle.outputFiles[0].text, {module, exports: module.exports, host, window,
    setTimeout(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id: number) { timers.delete(id); }, console: {error() {}},
  });
  return {
    calls, events, window, timers,
    createWriter: () => new writerModule.exports.ReadingProgressWriter(undefined, false),
    flushBookProgress: module.exports.flushBookProgress,
    attach: (writer: any, bookId = "A") => {
      writer.hasPending ??= () => false;
      return module.exports.retainReadingProgress(writer, () => { errors++; }, bookId);
    },
    get errors() { return errors; },
    close: () => closeHandler({preventDefault() { calls.push(["prevent", undefined]); }}),
    quit: (request = 1) => events.get("reader-exit-requested")!({payload: request}),
  };
}

test("register only after both native close and app-exit listeners are ready", async () => {
  const h = harness(); h.attach({flush: async () => true}); await settle();
  assert.ok(h.events.has("reader-exit-requested"));
  assert.equal(h.calls[0][0], "reader_exit_register");
});

test("normal close waits for successful saving and failed close remains retryable", async () => {
  const h = harness(); const saving = deferred<boolean>(); let result = saving.promise;
  h.attach({flush: () => result}); await settle();
  const closing = h.close(); assert.deepEqual(h.calls.map(([name]) => name), ["reader_exit_register", "prevent"]);
  saving.resolve(false); await closing;
  assert.equal(h.errors, 1); assert.ok(!h.calls.some(([name]) => name === "reader_close_saved"));
  result = Promise.resolve(true); await h.close();
  assert.equal(h.calls.at(-1)?.[0], "reader_close_saved");
});

test("application exit acknowledges only completed flushes and explicitly reports failure", async () => {
  const h = harness(); const saving = deferred<boolean>(); h.attach({flush: () => saving.promise}); await settle();
  const quit = h.quit(42); assert.ok(!h.calls.some(([name]) => name === "reader_exit_ack"));
  saving.resolve(false); await quit;
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), ["reader_exit_ack", {request: 42, saved: false}]);
  assert.equal(h.errors, 1);
});

test("unmounted failed writer survives book switches and saves before newer writers", async () => {
  const h = harness(); const order: string[] = []; let saved = false;
  const detach = h.attach({async flush() { order.push("A"); return saved; }}); await settle();
  detach(); await settle();
  h.attach({async flush() { order.push("B"); return true; }}); await settle();
  saved = true; order.length = 0; await h.quit();
  assert.deepEqual(order, ["A", "B"]);
  assert.equal(h.calls.at(-1)?.[1].saved, true);
});

test("late cleanup cannot remove a reattached writer (React strict effect replay)", async () => {
  const h = harness(); const saving = deferred<boolean>(); let count = 0;
  const writer = {flush: () => { count++; return saving.promise; }};
  const detach = h.attach(writer); await settle(); detach(); h.attach(writer);
  saving.resolve(true); await settle(); await h.quit(); assert.equal(count, 2);
});

test("timeout cancels close, retains the writer, and next close can retry", async () => {
  const h = harness(); const saving = deferred<boolean>(); h.attach({flush: () => saving.promise}); await settle();
  const closing = h.close(); [...h.timers.values()].forEach((timer) => timer()); await closing;
  assert.equal(h.errors, 1); assert.ok(!h.calls.some(([name]) => name === "reader_close_saved"));
  saving.resolve(true); await settle(); await h.close();
  assert.equal(h.calls.at(-1)?.[0], "reader_close_saved");
});

test("failed save after returning to library uses the existing error dialog", async () => {
  const h = harness(); const detach = h.attach({flush: async () => false}); await settle(); detach(); await settle();
  await h.quit(); assert.ok(h.calls.some(([name]) => name === "dialog"));
});

test("pagehide requests a flush and successful unmount retires the writer", async () => {
  const h = harness(); let count = 0; const detach = h.attach({async flush() { count++; return true; }}); await settle();
  h.window.dispatchEvent(new Event("pagehide")); detach(); await settle();
  await h.quit(); assert.equal(count, 2);
});


test("new reader in a registered window invalidates any older exit attempt", async () => {
  const h = harness(); h.attach({flush: async () => true}); await settle();
  h.attach({flush: async () => true}); await settle();
  assert.equal(h.calls.filter(([name]) => name === "reader_exit_register").length, 2);
});

test("position changed in an already-flushed reader is drained before acknowledgement", async () => {
  const h = harness(); let dirty = false; let writes = 0;
  h.attach({async flush() { writes++; dirty = false; return true; }, hasPending: () => dirty});
  h.attach({async flush() { dirty = true; return true; }}); await settle();
  await h.quit(); assert.equal(writes, 2);
  assert.equal(h.calls.at(-1)?.[1].saved, true);
});


test("A to B to A restoration waits for the old session's real in-flight database write", async () => {
  const gate = deferred<boolean>(); let dbProgress = 10; let writes = 0;
  const h = harness(async (_bookId, progress) => { if (++writes === 1) await gate.promise; dbProgress = progress; return false; });
  const old = h.createWriter(); const detach = h.attach(old, "A"); await settle();
  old.queue("A", 70, "current70"); detach();
  const current = h.createWriter(); h.attach(current, "A");
  let reads = 0;
  const result = restore(h, async () => { reads++; return {id: "A", current_cfi: `current${dbProgress}`, progress: dbProgress}; });
  await settle(); assert.equal(reads, 0);
  gate.resolve(true); await result.done;
  assert.equal(result.book.progress, 70);
  current.queue("A", result.book.progress, result.book.current_cfi); await current.flush();
  assert.equal(dbProgress, 70);
});

test("failed older save blocks stale database restore until explicit retry succeeds", async () => {
  let fail = true; let dbProgress = 10; let reads = 0;
  const h = harness(async (_bookId, progress) => { if (fail) throw new Error("disk failure"); dbProgress = progress; return false; });
  const old = h.createWriter(); const detach = h.attach(old, "A"); await settle();
  old.queue("A", 70, "current70"); detach(); await settle();
  h.attach(h.createWriter(), "A");
  const readBook = async () => { reads++; return {id: "A", current_cfi: `current${dbProgress}`, progress: dbProgress}; };
  const failed = restore(h, readBook); await failed.done;
  assert.equal(reads, 0); assert.equal(failed.book, undefined); assert.equal(failed.error.detail, "notes.saveFailed");
  fail = false; const retried = restore(h, readBook); await retried.done;
  assert.equal(retried.book.progress, 70); assert.equal(reads, 1);
});
