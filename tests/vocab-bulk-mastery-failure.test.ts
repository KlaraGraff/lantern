import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import i18next from "i18next";
import ts from "typescript";

/**
 * `applyBulkMastery` lives inside `DictionaryContent`, so it is pulled out of
 * the source and run against stand-ins for the state it touches. The bug: a
 * failed bulk status change only reached the console, so the reader saw the
 * same list as if it had worked.
 */
function handler(globals: Record<string, unknown>) {
  const file = "src/components/DictionaryContent.tsx";
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "applyBulkMastery") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(declaration?.initializer);
  const code = ts.transpile(`(${declaration.initializer.getText(tree)})`, { target: ts.ScriptTarget.ES2022 });
  return runInNewContext(code, globals) as () => Promise<void>;
}

function page(invoke: () => Promise<unknown>) {
  const calls = { failed: [] as (number | null)[], selection: [] as Set<string>[], busy: [] as boolean[], refreshes: 0 };
  const run = handler({
    selectedWordIds: new Set(["a", "b", "c"]),
    bulkMastery: "mastered",
    Date,
    invoke,
    console: { error() {} },
    window: { setTimeout: () => 1, clearTimeout() {} },
    bulkMasteryFailedTimer: { current: null },
    setBulkBusy: (busy: boolean) => calls.busy.push(busy),
    setBulkMasteryFailed: (count: number | null) => calls.failed.push(count),
    setSelectedWordIds: (next: Set<string>) => calls.selection.push(next),
    refreshWords: async () => { calls.refreshes += 1; },
  });
  return { run, calls };
}

test("a failed bulk status change says how many words were left unchanged", async () => {
  const { run, calls } = page(() => Promise.reject(new Error("row unreadable")));
  await run();
  // The batch is one transaction: on failure none of the three changed.
  assert.deepEqual(calls.failed, [3]);
  assert.deepEqual(calls.selection, [], "the selection stays for another try");
  assert.deepEqual(calls.busy, [true, false]);
});

test("a bulk status change that goes through shows no failure and clears the selection", async () => {
  const { run, calls } = page(() => Promise.resolve(3));
  await run();
  assert.deepEqual(calls.failed, []);
  assert.equal(calls.refreshes, 1);
  assert.equal(calls.selection.length, 1);
  assert.equal(calls.selection[0].size, 0);
  assert.deepEqual(calls.busy, [true, false]);
});

test("the failure message counts words in both languages", async () => {
  const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")) as Record<string, string>;
  const i18n = i18next.createInstance();
  await i18n.init({ resources: { en: { translation: en }, zh: { translation: zh } }, lng: "en", interpolation: { escapeValue: false } });
  assert.equal(i18n.t("vocab.bulk.masteryFailed", { count: 1 }), "1 word wasn't changed");
  assert.equal(i18n.t("vocab.bulk.masteryFailed", { count: 3 }), "3 words weren't changed");
  assert.equal(i18n.t("vocab.bulk.masteryFailed", { lng: "zh", count: 3 }), "有 3 个词没改成功");
});
