import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { addPendingWrites, removePendingWrites } from "../src/components/settings/settings-rehydration.ts";

function handler(file: string, name: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(declaration?.initializer);
  return runInNewContext(ts.transpile(`(${declaration.initializer.getText(tree)})`, {target: ts.ScriptTarget.ES2022}), globals);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const failure = "readerSettings.scope.actionFailed";
function feedback() {
  const toasts: (string | undefined)[] = [];
  return {toasts, t: (key: string) => key, showSavedToast: (message?: string) => toasts.push(message), console: {error() {}}};
}

test("speech settings report rejection, then allow the next save to succeed", async () => {
  const h = feedback(); const first = deferred(); let writes = 0;
  const persist = handler("src/components/settings/SpeechSettings.tsx", "persist", {
    ...h, updateSpeechSettings: () => ++writes === 1 ? first.promise : Promise.resolve(),
  });
  persist({speech_rate: "1.2"}); assert.deepEqual(h.toasts, []);
  first.reject(new Error("disk full")); await settle();
  assert.deepEqual(h.toasts, [failure]);
  persist({speech_rate: "1.2"}); await settle();
  assert.equal(writes, 2); assert.deepEqual(h.toasts, [failure, undefined]);
});

test("legacy tool settings surface failed saves and release pending keys for retry", async () => {
  const h = feedback(); let fail = true; let notifications = 0;
  const pendingWritesRef = {current: new Map<string, number>()};
  const persist = handler("src/components/settings/ToolsSettings.tsx", "persistLegacy", {
    ...h, pendingWritesRef, appliedRef: {current: {}}, addPendingWrites, removePendingWrites,
    save: async () => {if (fail) throw new Error("disk full");},
    notifyReadingAssistanceSettingsChanged: async () => {notifications++;},
  });
  persist("dictionary_lookup_enabled", "false"); await settle();
  assert.deepEqual(h.toasts, [failure]); assert.equal(pendingWritesRef.current.size, 0); assert.equal(notifications, 0);
  fail = false; persist("dictionary_lookup_enabled", "false"); await settle();
  assert.deepEqual(h.toasts, [failure, undefined]); assert.equal(notifications, 1); assert.equal(pendingWritesRef.current.size, 0);
});

test("a rejected learning-tool save reports failure without breaking its existing queue", async () => {
  const h = feedback(); const first = deferred(); const writes: string[] = []; let notifications = 0;
  const pendingWritesRef = {current: new Map<string, number>()};
  const saveQueue = {current: Promise.resolve()};
  const queue = handler("src/components/settings/ToolsSettings.tsx", "queueSave", {
    ...h, saveQueue, pendingWritesRef, appliedRef: {current: {}}, addPendingWrites, removePendingWrites,
    saveBulk: (entries: Record<string, string>) => {writes.push(entries.card); return writes.length === 1 ? first.promise : Promise.resolve();},
    notifyReadingAssistanceSettingsChanged: async () => {notifications++;},
  });
  queue({card: "first"}); queue({card: "second"}, "saved second"); await settle();
  assert.deepEqual(writes, ["first"]); assert.deepEqual(h.toasts, []);
  first.reject(new Error("disk full")); await saveQueue.current;
  assert.deepEqual(writes, ["first", "second"]);
  assert.deepEqual(h.toasts, [failure, "saved second"]);
  assert.equal(notifications, 1); assert.equal(pendingWritesRef.current.size, 0);
});
