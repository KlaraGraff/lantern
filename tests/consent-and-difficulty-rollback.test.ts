import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * The same extractor `tests/settings-save-feedback.test.ts` uses: the action
 * under test is a `const` in a React module, and running its initializer in a
 * VM with stubbed hooks is how this repo tests a component-internal action
 * without a renderer.
 */
function sourceAction(file: string, name: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
      expression = node.initializer!.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `could not find ${name} in ${file}`);
  return runInNewContext(
    ts.transpile(`const action = ${expression};\naction;`, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    }),
    globals,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("a consent answer still reaches the waiting caller when the setting write fails", async () => {
  const resolved: string[] = [];
  const writes: { key: string; value: string }[] = [];

  const answer = sourceAction(
    "src/hooks/useCellularDownloadConsent.tsx",
    "answer",
    {
      useCallback: (fn: unknown) => fn,
      open: true,
      setOpen: () => {},
      resolverRef: { current: (value: string) => resolved.push(value) },
      CELLULAR_CONSENT_SETTING_KEY: "icloud_download_on_cellular",
      invoke: async (cmd: string, args: { key: string; value: string }) => {
        writes.push(args);
        throw new Error("database is locked");
      },
    },
  );

  await answer("allow");

  // JSON rather than deepEqual: the action runs in a VM realm, whose arrays
  // have a different prototype and fail an identity-sensitive deep compare.
  assert.equal(JSON.stringify(writes), '[{"key":"icloud_download_on_cellular","value":"allow"}]');
  assert.equal(JSON.stringify(resolved), '["allow"]');
});

test("a failed override write keeps the newer difficulty row that arrived meanwhile", async () => {
  const write = deferred<void>();
  let state: Record<string, unknown> = { status: "done", override: null, computedAt: 1 };
  const staleRow = state;

  const setOverride = sourceAction("src/hooks/useBookDifficulty.ts", "setOverride", {
    useCallback: (fn: unknown) => fn,
    bookId: "book-1",
    difficulty: staleRow,
    setCallError: () => {},
    setDifficulty: (updater: unknown) => {
      state = typeof updater === "function"
        ? (updater as (prev: unknown) => Record<string, unknown>)(state)
        : (updater as Record<string, unknown>);
    },
    setBookDifficultyOverride: () => write.promise,
  });

  const pending = setOverride("easier");
  assert.equal(state.override, "easier", "the override is painted optimistically");

  // The finished analysis lands while the write is still in flight.
  state = { status: "done", override: null, computedAt: 2 };

  write.reject(new Error("BOOK_DIFFICULTY_OVERRIDE_INVALID"));
  await pending;

  assert.equal(state.computedAt, 2, "the fresher row survives the rollback");
  assert.equal(state.override, null, "only the optimistically written field is rolled back");
});
