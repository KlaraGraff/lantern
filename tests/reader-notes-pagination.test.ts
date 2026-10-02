import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/pages/reader/load-reader-notes.ts"], bundle: true, write: false,
  format: "cjs", platform: "node", plugins: [{ name: "invoke", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, ({ path }) => ({ path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const invoke = globalThis.invoke;" }));
  } }],
});

// Execute each real consumer callback, rather than a duplicate of its paging
// logic. READER_BASELINE=1 runs the same cases against the pre-fix callbacks.
function callback(file: string, name: string, globals: Record<string, any>) {
  const source = process.env.READER_BASELINE ? execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }) : readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) expression = node.initializer!.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(expression);
  const js = ts.transpile(`const callback = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return runInNewContext(`${js}\ncallback`, { useCallback: (fn: any) => fn, ...globals });
}

function notesHost() {
  const requests: any[] = [];
  const rows = Array.from({ length: 1001 }, (_, id) => ({ id: `${id}`, location: `cfi-${id}` }));
  const invoke = async (command: string, args: any) => {
    if (command !== "list_notes") return [];
    requests.push(args);
    const offset = Number(args.cursor ?? 0);
    return { notes: rows.slice(offset, offset + 500), next_cursor: offset + 500 < rows.length ? `${offset + 500}` : null };
  };
  const module = { exports: {} as { loadReaderNotes: (...args: any[]) => Promise<any> } };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, invoke });
  return { requests, rows, invoke, loadReaderNotes: module.exports.loadReaderNotes };
}

for (const consumer of ["notes", "anchors"]) {
  test(`${consumer} consumer loads all 1001 notes through cursors`, async () => {
    const h = notesHost(); let published: any[] = [];
    const globals = {
      ...h, bookId: "book", NOTES_PAGE_SIZE: 500, NOTE_ANCHOR_LIMIT: 500, AbortController,
      notesRequestRef: { current: null }, annotationRequestRef: { current: null },
      setNotes: (notes: any[]) => { published = notes; }, setFailed() {}, setLoading() {},
      isTextBook: false, supportsManualAnnotations: true, supportsWordMarkers: false,
      viewRef: { current: {} }, markerSnapshotRef: { current: null as any },
      applyAnnotations: async () => {}, applyFoliateMarkerStyles() {}, applyPassiveVocabAnnotations() {},
    };
    const file = consumer === "notes" ? "src/components/ReaderNotesPanel.tsx" : "src/pages/reader/useFoliateAnnotations.ts";
    await callback(file, consumer === "notes" ? "refreshNotes" : "refreshAnnotations", globals)();
    if (consumer === "anchors") published = globals.markerSnapshotRef.current.noteAnchors;
    assert.equal(published.length, 1001);
    assert.deepEqual(h.requests.map((request) => request.cursor), [null, "500", "1000"]);
    assert.ok(h.requests.every((request) => request.bookId === "book" && request.anchorKind === (consumer === "notes" ? null : "selection")));
  });
}

test("aborting a paged load prevents further pages and partial publication", async () => {
  const h = notesHost(); const request = new AbortController();
  request.abort();
  assert.equal(await h.loadReaderNotes("A", null, request.signal), null);
  assert.equal(h.requests.length, 0);
});

test("refresh invalidates the in-flight note list and only publishes the new one", async () => {
  const h = notesHost(); let publish: any[] = [];
  let resolve!: (page: any) => void;
  const stale = new Promise((yes) => { resolve = yes; }); let calls = 0;
  const invoke = async () => ++calls === 1 ? stale : { notes: [{ id: "fresh" }], next_cursor: null };
  const module = { exports: {} as { loadReaderNotes: (...args: any[]) => Promise<any> } };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, invoke });
  const refresh = callback("src/components/ReaderNotesPanel.tsx", "refreshNotes", {
    ...h, invoke, loadReaderNotes: module.exports.loadReaderNotes, bookId: "A", AbortController,
    notesRequestRef: { current: null }, NOTES_PAGE_SIZE: 500,
    setNotes: (notes: any[]) => { publish = notes; }, setFailed() {}, setLoading() {},
  });
  const first = refresh(); await refresh();
  resolve({ notes: [{ id: "stale" }], next_cursor: "next-stale" }); await first;
  assert.equal(publish[0].id, "fresh"); assert.equal(calls, 2);
});

test("cancelling between pages discards the accumulated first page and stops paging", async () => {
  let resolve!: (page: any) => void; let calls = 0;
  const second = new Promise((yes) => { resolve = yes; });
  const invoke = async () => ++calls === 1
    ? { notes: Array.from({ length: 500 }, (_, id) => ({ id })), next_cursor: "page-2" }
    : second;
  const module = { exports: {} as { loadReaderNotes: (...args: any[]) => Promise<any> } };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, invoke });
  const request = new AbortController();
  const load = module.exports.loadReaderNotes("A", null, request.signal);
  await new Promise<void>((yes) => setImmediate(yes)); assert.equal(calls, 2);
  request.abort(); resolve({ notes: [{ id: "old" }], next_cursor: "page-3" });
  assert.equal(await load, null); assert.equal(calls, 2);
});

test("a repeated cursor fails rather than looping forever", async () => {
  const module = { exports: {} as { loadReaderNotes: (...args: any[]) => Promise<any> } };
  let calls = 0;
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
    invoke: async () => { calls++; return { notes: [], next_cursor: "same" }; },
  });
  await assert.rejects(module.exports.loadReaderNotes("A", null, new AbortController().signal), /Repeated note cursor/);
  assert.equal(calls, 2);
});
