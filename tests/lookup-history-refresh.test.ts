import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * Runs the body of `useAllLookupHistory` with stubbed React hooks, the way
 * `tests/consent-and-difficulty-rollback.test.ts` runs a hook's actions without
 * a renderer: effects run once, straight away, which is all a mount does.
 */
function mountLookupHistory(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  const file = "src/hooks/useDictionary.ts";
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration = "";
  ts.forEachChild(tree, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "useAllLookupHistory") {
      declaration = node.getText(tree).replace(/^export\s+/, "");
    }
  });
  assert.ok(declaration, "could not find useAllLookupHistory");
  const window = new EventTarget();
  const hook = runInNewContext(
    ts.transpile(`${declaration}\nuseAllLookupHistory;`, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    }),
    {
      useState: (initial: unknown) => [initial, () => {}],
      useCallback: (fn: unknown) => fn,
      useRef: (current: unknown) => ({ current }),
      useEffect: (effect: () => void) => { effect(); },
      invoke,
      notifyReaders: () => {},
      window,
      console,
    },
  );
  return { api: hook() as { refresh: (search?: string, bookId?: string) => Promise<void> }, window };
}

const emptyPage = { records: [], next_cursor: null, total: 0, books: [] };

test("a lookup record changing elsewhere reloads the history with the reader's filter", async () => {
  const queries: string[] = [];
  const { api, window } = mountLookupHistory(async (_command, args) => {
    queries.push(JSON.stringify({ search: args.search, bookId: args.bookId }));
    return emptyPage;
  });

  await api.refresh("courage", "book-1");
  window.dispatchEvent(new Event("lookup-record-changed"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(queries, [
    '{"search":null,"bookId":null}',
    '{"search":"courage","bookId":"book-1"}',
    // The reload used to run unfiltered, so the list jumped back to every
    // lookup in every book while the search box still showed "courage".
    '{"search":"courage","bookId":"book-1"}',
  ]);
});
