import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("src/hooks/useAiChat.ts", "utf8");
const tree = ts.createSourceFile("useAiChat.ts", source, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "generateAiTitle")!;
const js = ts.transpile(fn.getText(tree), { target: ts.ScriptTarget.ES2022 });
function harness(failStart = false) {
  let listener!: (event: any) => void; let timeout!: () => void; const commands: string[] = [];
  const generate = runInNewContext(`${js}\ngenerateAiTitle`, {
    createUuid: () => "test", setTimeout(fn: () => void) { timeout = fn; return 1; }, clearTimeout() {},
    async listen(_name: string, fn: typeof listener) { listener = fn; return () => {}; },
    async invoke(command: string) { commands.push(command); if (failStart && command === "ai_generate_title") throw new Error("start failed"); },
  });
  return { start: () => generate("question"), commands,
    chunk(payload: any) { listener({ payload }); }, timeout() { timeout(); } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("partial title followed by local timeout cancels the backend request", async () => {
  const h = harness(); const result = h.start(); await settle();
  h.chunk({ delta: "partial", done: false }); h.timeout();
  assert.equal(await result, null); assert.deepEqual(h.commands, ["ai_generate_title", "ai_cancel"]);
});

test("successful service done does not cancel the completed request", async () => {
  const h = harness(); const result = h.start(); await settle();
  h.chunk({ delta: '"A title."', done: false }); h.chunk({ delta: "", done: true });
  assert.equal(await result, "A title"); assert.deepEqual(h.commands, ["ai_generate_title"]);
});

test("failed start cancels even after a partial delta", async () => {
  const h = harness(true); const result = h.start();
  // listen is already installed before invoke's rejected result is handled.
  h.chunk({ delta: "partial", done: false });
  assert.equal(await result, null); assert.deepEqual(h.commands, ["ai_generate_title", "ai_cancel"]);
});

test("a done event arriving after local timeout cannot turn it into successful completion", async () => {
  const h = harness(); const result = h.start(); await settle();
  h.chunk({ delta: "partial", done: false }); h.timeout(); h.chunk({ delta: "", done: true });
  assert.equal(await result, null); assert.deepEqual(h.commands, ["ai_generate_title", "ai_cancel"]);
});
