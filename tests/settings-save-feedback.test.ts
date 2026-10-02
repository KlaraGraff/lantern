import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { build } from "esbuild";
import { createSettingsSaveFeedback, runSettingsSave } from "../src/components/settings/settings-save-feedback.ts";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((yes) => setImmediate(yes));

test("feedback waits for persistence, failures are retryable, and stale success remains success", async () => {
  const feedback = createSettingsSaveFeedback(); const events: string[] = [];
  const first = deferred<void>(); const second = deferred<void>();
  const a = runSettingsSave(feedback, ["theme"], () => first.promise, () => events.push("failed A"), () => events.push("saved A"));
  const b = runSettingsSave(feedback, ["theme"], () => second.promise, () => events.push("failed B"), () => events.push("saved B"));
  assert.equal(events.length, 0);
  first.resolve(); assert.equal(await a, true); assert.equal(events.length, 0);
  second.reject(new Error("failed")); assert.equal(await b, false); assert.deepEqual(events, ["failed B"]);
  assert.equal(await runSettingsSave(feedback, ["theme"], async () => {}, () => events.push("failed retry"), () => events.push("saved retry")), true);
  assert.deepEqual(events, ["failed B", "saved retry"]);
});

test("an unrelated pending save cannot suppress failure or cover it with Saved", async () => {
  const feedback = createSettingsSaveFeedback(); const events: string[] = [];
  const first = deferred<void>(); const second = deferred<void>();
  const a = runSettingsSave(feedback, ["auto_save"], () => first.promise, () => events.push("auto-save failed"), () => events.push("auto-save saved"));
  const b = runSettingsSave(feedback, ["font_family"], () => second.promise, () => events.push("font failed"), () => events.push("font saved"));
  first.reject(new Error("failed")); assert.equal(await a, false);
  second.resolve(); assert.equal(await b, true);
  assert.deepEqual(events, ["auto-save failed"]);
});

function sourceAction(file: string, name: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8"); const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) expression = node.initializer!.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(expression);
  return runInNewContext(ts.transpile(`const action = ${expression};\naction;`, { target: ts.ScriptTarget.ES2022 }), globals);
}

function generalHost() {
  const requests: { key: string; value: string; result: ReturnType<typeof deferred<void>> }[] = [];
  const feedback: string[] = []; const persisted: Record<string, string> = {};
  const persist = sourceAction("src/components/settings/GeneralSettings.tsx", "persist", {
    saveFeedbackRef: { current: createSettingsSaveFeedback() }, savesRef: { current: Promise.resolve() }, runSettingsSave,
    async save(key: string, value: string) {
      const result = deferred<void>(); requests.push({ key, value, result }); await result.promise; persisted[key] = value;
    },
    t: (key: string) => key, showSavedToast: (message?: string) => feedback.push(message ?? "saved"),
  });
  return { persist, requests, feedback, persisted };
}

test("General applies every confirmed global change in order, including success followed by failure", async () => {
  const h = generalHost(); const global: string[] = ["en"];
  const a = h.persist("language", "zh", async () => { await settle(); global.push("zh"); });
  const b = h.persist("language", "fr", () => global.push("fr"));
  await settle(); assert.equal(h.requests.length, 1); assert.deepEqual(global, ["en"]);
  h.requests[0].result.resolve(); assert.equal(await a, true); await settle();
  assert.equal(h.requests.length, 2); assert.deepEqual(global, ["en", "zh"]);
  h.requests[1].result.reject(new Error("write failed")); assert.equal(await b, false);
  assert.equal(h.persisted.language, "zh"); assert.deepEqual(global, ["en", "zh"]);
  assert.deepEqual(h.feedback, ["readerSettings.scope.actionFailed"]);
});

test("Reading persist returns true for an obsolete but successful restore and reports actual rejection", async () => {
  const requests: ReturnType<typeof deferred<void>>[] = []; const feedback: string[] = [];
  const persist = sourceAction("src/components/settings/ReadingSettings.tsx", "persist", {
    useCallback: <T>(fn: T) => fn, saveFeedbackRef: { current: createSettingsSaveFeedback() }, runSettingsSave,
    pendingWritesRef: { current: new Map() }, appliedRef: { current: {} },
    addPendingWrites() {}, removePendingWrites() {}, setWritesSettled() {},
    saveBulk() { const result = deferred<void>(); requests.push(result); return result.promise; },
    t: (key: string) => key, showSavedToast: (message?: string) => feedback.push(message ?? "saved"),
  });
  const restore = persist({ auto_save: "true" }, { repaint: true, toast: true });
  const change = persist({ auto_save: "false" }, { toast: true });
  assert.deepEqual(feedback, []);
  requests[0].resolve(); assert.equal(await restore, true); assert.deepEqual(feedback, []);
  requests[1].reject(new Error("failed")); assert.equal(await change, false);
  assert.deepEqual(feedback, ["readerSettings.scope.actionFailed"]);
});

function generalDraftHandlers(globals: Record<string, unknown>) {
  const file = "src/components/settings/GeneralSettings.tsx";
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") expressions.echo = node.arguments[0].getText(tree);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "input") {
      for (const prop of node.attributes.properties) if (ts.isJsxAttribute(prop) && ["onChange", "onBlur"].includes(prop.name.getText(tree))) {
        expressions[prop.name.getText(tree)] = (prop.initializer as ts.JsxExpression).expression!.getText(tree);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return Object.fromEntries(Object.entries(expressions).map(([name, expression]) => [name,
    runInNewContext(ts.transpile(`const fn = ${expression};\nfn;`, { target: ts.ScriptTarget.ES2022 }), { ...globals })]));
}

for (const saved of [true, false]) test(`nickname draft survives a ${saved ? "successful" : "failed"} earlier blur save`, async () => {
  const h = generalHost(); let displayed = "Reader";
  const draft = { current: { value: "Reader", dirty: false } }; const settings = { user_name: "Reader" };
  const handlers = generalDraftHandlers({ displayNameDraftRef: draft, settings, loading: false,
    setDisplayName: (name: string) => { displayed = name; }, setLanguage() {}, setAutoCheckUpdates() {}, persist: h.persist });
  handlers.onChange({ target: { value: "A" } }); handlers.onBlur(); await settle();
  handlers.onChange({ target: { value: "B" } }); settings.user_name = "A"; handlers.echo();
  assert.equal(displayed, "B");
  if (saved) h.requests[0].result.resolve(); else h.requests[0].result.reject(new Error("failed"));
  await settle(); handlers.echo(); assert.equal(displayed, "B"); assert.equal(draft.current.dirty, true);
  handlers.onBlur(); await settle(); assert.equal(h.requests[1].value, "B");
  h.requests[1].result.resolve(); await settle(); assert.equal(draft.current.dirty, false);
});

test("a failed explanation-style selection can retry the same selected style", () => {
  const file = "src/components/settings/LearningSettings.tsx";
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === "onClick" && node.initializer?.getText(tree).includes('save("explanation_style", style)')) {
      expression = (node.initializer as ts.JsxExpression).expression!.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(expression); let calls = 0;
  const settings = { explanation_style: "thorough" };
  const handler = runInNewContext(ts.transpile(`const fn = ${expression};\nfn;`, { target: ts.ScriptTarget.ES2022 }), {
    selected: true, style: "essential", settings, normalizedExplanationStyle: (value: string) => value,
    setExplanationStyle() {}, setStyleSampleOpen() {}, save() { calls++; return Promise.resolve(); },
    saveWithFeedback(_keys: string[], write: () => Promise<void>) { return write(); },
  });
  handler(); assert.equal(calls, 1); settings.explanation_style = "essential"; handler(); assert.equal(calls, 1);
});

const settingsBundle = await build({ entryPoints: ["src/hooks/useSettings.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "settings-boundaries", setup(builder) {
    builder.onResolve({ filter: /^react$|^@tauri-apps\/api\/core$|settings-events\.ts$/ }, ({ path }) => ({ path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: path === "react"
      ? "export const {useState,useRef,useCallback,useEffect} = globalThis.host;"
      : path.includes("settings-events") ? "export const notifySettingsChanged = globalThis.host.notify; export const listenForSettingsChanged=async()=>()=>{}; export const applySettingsChange = (_a,b)=>b;"
        : "export const invoke = globalThis.host.invoke;" }));
  } }],
});

test("useSettings serializes bulk/single writes, rejects failure, and continues with the latest value", async () => {
  const requests: { command: string; args: Record<string, unknown>; result: ReturnType<typeof deferred<void>> }[] = [];
  const states: unknown[] = []; const notifications: Record<string, string>[] = [];
  const module = { exports: {} as { useSettings: () => { saveBulk: (entries: Record<string, string>) => Promise<void>; save: (key: string, value: string) => Promise<void> } } };
  runInNewContext(settingsBundle.outputFiles[0].text, { module, exports: module.exports, console,
    host: {
      useState<T>(initial: T) { const index = states.length; states.push(initial); return [initial, (value: T | ((previous: T) => T)) => { states[index] = typeof value === "function" ? (value as (previous: T) => T)(states[index] as T) : value; }]; },
      useRef: <T>(current: T) => ({ current }), useCallback: <T>(fn: T) => fn, useEffect() {},
      invoke(command: string, args: Record<string, unknown>) { const result = deferred<void>(); requests.push({ command, args, result }); return result.promise; },
      async notify(values: Record<string, string>) { notifications.push(values); },
    },
  });
  const hook = module.exports.useSettings(); const a = hook.saveBulk({ theme: "A" }); const rejected = assert.rejects(a, /failed/);
  const b = hook.save("theme", "B"); await settle(); assert.equal(requests.length, 1);
  requests[0].result.reject(new Error("failed")); await rejected; await settle(); assert.equal(requests.length, 2);
  requests[1].result.resolve(); await b;
  assert.equal((states[0] as Record<string, string>).theme, "B"); assert.equal(notifications.length, 1); assert.equal(notifications[0].theme, "B");
});
