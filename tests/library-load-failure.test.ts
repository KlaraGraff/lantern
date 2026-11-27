import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * Runs `useBooks` with a minimal stand-in for React: state lives across
 * renders by call order, effects run on the first render only. Same idea as
 * `tests/consent-and-difficulty-rollback.test.ts`, which runs a hook's actions
 * in a VM without a renderer.
 */
function renderUseBooks(invoke: () => Promise<unknown>) {
  const file = "src/hooks/useBooks.ts";
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration = "";
  ts.forEachChild(tree, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "useBooks") {
      declaration = node.getText(tree).replace(/^export\s+/, "");
    }
  });
  assert.ok(declaration, "could not find useBooks");
  const slots: unknown[] = [];
  let slot = 0;
  let mounted = false;
  const useSlot = <T>(make: () => T): T => {
    const index = slot++;
    if (!(index in slots)) slots[index] = make();
    return slots[index] as T;
  };
  const hook = runInNewContext(
    ts.transpile(`${declaration}\nuseBooks;`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }),
    {
      useState: (initial: unknown) => {
        const index = slot;
        const value = useSlot(() => initial);
        return [value, (next: unknown) => {
          slots[index] = typeof next === "function" ? (next as (v: unknown) => unknown)(slots[index]) : next;
        }];
      },
      useRef: (current: unknown) => useSlot(() => ({ current })),
      useCallback: (fn: unknown) => fn,
      useEffect: (effect: () => void) => { if (!mounted) effect(); },
      useLayoutEffect: () => {},
      invoke,
      console: { error: () => {} },
      JSON,
    },
  );
  return () => {
    slot = 0;
    const result = hook() as { books: unknown[]; loading: boolean; failed?: boolean };
    mounted = true;
    return result;
  };
}

test("a library that fails to load says so instead of looking empty", async () => {
  const render = renderUseBooks(async () => { throw new Error("database is locked"); });
  render();
  await new Promise((resolve) => setImmediate(resolve));
  const after = render();
  assert.equal(after.loading, false);
  assert.equal(after.books.length, 0);
  // Without this the shelf could only read "no books yet — import one".
  assert.equal(after.failed, true);
});

test("a library that loads is not marked failed", async () => {
  const render = renderUseBooks(async () => ({ books: [], next_cursor: null, total: 0 }));
  render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render().failed, false);
});
