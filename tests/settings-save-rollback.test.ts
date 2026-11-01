import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import {
  BUILT_IN_BOOK_SOURCES,
  resolveBookSources,
  serializeBookSources,
  type BookSource,
} from "../src/components/book-sources.ts";

/**
 * A settings save that the backend rejects must not leave the pane showing what
 * the database never took. The handlers are evaluated from source with stubbed
 * dependencies, since the panes themselves need a DOM.
 */

const userSource: BookSource = {
  id: "user:3f1c",
  name: "My site",
  url: "https://example.com/",
  kind: "library",
};

/**
 * `BookSourcesSettings.persist` is the only writer of `book_sources`, and it is
 * an arrow function in a `.tsx` file, so it is lifted out of the source with
 * the same AST trick `settings-save-errors-surfaces.test.ts` uses — no JSX is
 * evaluated, only the function body, with its imports stubbed.
 */
function sourceArrow(file: string, name: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
      expression = node.initializer!.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `${name} not found in ${file}`);
  return runInNewContext(ts.transpile(`const fn = ${expression};\nfn;`, { target: ts.ScriptTarget.ES2022 }), globals);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a rejected book-sources save is reported and the list falls back to what was stored", async () => {
  const stored = serializeBookSources([userSource]);
  const rendered: BookSource[][] = [];
  const toasts: (string | undefined)[] = [];
  const persist = sourceArrow("src/components/settings/BookSourcesSettings.tsx", "persist", {
    BOOK_SOURCES_KEY: "book_sources",
    resolveBookSources,
    serializeBookSources,
    settings: { book_sources: stored },
    t: (key: string) => key,
    showSavedToast: (message?: string) => toasts.push(message),
    console: { error() {} },
    saveBulk: () => Promise.reject(new Error("disk full")),
    setSources: (next: BookSource[]) => rendered.push(next),
  });

  persist([...BUILT_IN_BOOK_SOURCES, userSource]);

  // The new list is shown while the write is in flight…
  assert.deepEqual(rendered[0], [...BUILT_IN_BOOK_SOURCES, userSource]);
  await settle();

  // …and when the write fails the pane must not keep claiming it succeeded.
  assert.deepEqual(
    rendered[rendered.length - 1],
    [userSource],
    "a failed save leaves the pane showing entries the database never received",
  );
  assert.deepEqual(toasts, ["readerSettings.scope.actionFailed"], "the reader is told the save failed");
});

function autoAnalysisHandler(name: string, globals: Record<string, unknown>) {
  return sourceArrow("src/components/settings/AutoAnalysisSettings.tsx", name, globals);
}

test("a job switch that fails to save re-reads the console instead of claiming it moved", async () => {
  const events: string[] = [];
  const setEnabled = autoAnalysisHandler("setEnabled", {
    invoke: async () => { throw new Error("database is locked"); },
    load: async () => { events.push("load"); },
    setBusy: (value: string | null) => events.push(`busy:${value}`),
    console: { error() {} },
  });

  await setEnabled("reading_review", false);

  // The stored value never changed, so the row has to be re-read from it —
  // otherwise the console shows a switch that did nothing.
  assert.deepEqual(events, ["busy:reading_review", "load", "busy:null"]);
});

test("turning everything off keeps going after one job fails, then re-reads", async () => {
  const calls: string[] = [];
  let loadCount = 0;
  const turnEverythingOff = autoAnalysisHandler("turnEverythingOff", {
    data: { jobs: [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: false }] },
    invoke: async (_command: string, args: { jobId: string }) => {
      calls.push(args.jobId);
      if (args.jobId === "a") throw new Error("database is locked");
    },
    load: async () => { loadCount += 1; },
    setBusy: () => {},
    console: { error() {} },
  });

  await turnEverythingOff();

  assert.deepEqual(calls, ["a", "b"], "a failing job must not cancel the ones after it");
  assert.equal(loadCount, 1, "the rows shown afterwards must be the stored ones");
});
