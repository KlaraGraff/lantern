import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = process.env.READER_BASELINE
  ? execFileSync("git", ["show", "HEAD:src/pages/Reader.tsx"], { encoding: "utf8" })
  : readFileSync("src/pages/Reader.tsx", "utf8");
const tree = ts.createSourceFile("Reader.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function execute(text: string, globals: Record<string, any>) {
  return runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }), globals);
}

test("route identity replaces the whole reader session before any child render", () => {
  const wrapper = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "Reader")!;
  // A wrapper, rather than a post-render effect, isolates all transient state.
  assert.ok(tree.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ReaderSession"));
  let bookId = "A";
  const ReaderSession = Symbol("ReaderSession");
  const Reader = execute(`${wrapper.getText(tree).replace("export default ", "")}\nReader;`, {
    useParams: () => ({ bookId }), ReaderSession,
    React: { createElement(type: any, props: any) { return { type, props }; } },
  });
  const a = Reader(); bookId = "B"; const b = Reader();
  assert.equal(a.type, ReaderSession); assert.equal(b.type, ReaderSession);
  assert.equal(a.props.bookId, "A"); assert.equal(b.props.bookId, "B");
  assert.notEqual(a.props.key, b.props.key);
  assert.equal(b.props.key, "B"); assert.equal(Reader().props.key, "B");
});


test("font-loading failure cannot enable auto-save when its own stored setting is false", async () => {
  const start = source.indexOf("    const autoSaveRevision = autoSaveRevisionRef.current;");
  const end = source.indexOf("    return () => {", start);
  assert.ok(start > 0 && end > start);
  const changes: boolean[] = [];
  const settings = {auto_save: "false"};
  execute(source.slice(start, end), {
    cancelled: false, autoSaveRevisionRef: {current: 0}, bookId: "A",
    progressWriter: {setAutoSave: (value: boolean) => changes.push(value)},
    getAllSettings: async () => settings,
    loadCustomFonts: async () => { throw new Error("font load failure"); },
    getBookSettings: async () => ({}),
    setSettingsSettledBookId() {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [false]);
});
