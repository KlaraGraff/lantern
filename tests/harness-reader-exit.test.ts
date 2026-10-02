import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

// Test browser-only command shapes and unknown-command accounting. Native
// window destruction and application termination require separate app checks.
const bundled = await build({
  stdin: { contents: 'export { invoke } from "./harness/tauri/core"; export { harness } from "./harness/state";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "deterministic-macrotask", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/task$|^virtual:harness-rust-shapes$/ }, ({ path }) => ({ path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: path.startsWith("virtual:")
      ? "export default {};" : "export const macrotask = () => Promise.resolve();" }));
  } }],
});
function harnessHost() {
  const module = { exports: {} as { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    harness: { unstubbed: Set<string>; stubsSinceMark: string[]; calls: { command: string; args: unknown }[] } } };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports,
    window: { location: { search: "" } }, URLSearchParams, btoa, console, setTimeout, clearTimeout });
  return module.exports;
}

test("reader exit IPC gets explicit unit-return fixtures without claiming native exit", async () => {
  const h = harnessHost();
  for (const [command, args] of [
    ["reader_exit_register", undefined],
    ["reader_exit_ack", { request: 1, saved: true }],
    ["reader_exit_ack", { request: 1, saved: false }],
    ["reader_close_saved", undefined],
  ] as const) {
    assert.equal(await h.invoke(command, args), null);
    assert.equal(h.harness.unstubbed.has(command), false);
  }
  assert.equal(h.harness.stubsSinceMark.length, 0);
  assert.equal(h.harness.calls.length, 4);
});

test("exit fixtures do not weaken the unknown-command gate", async () => {
  const h = harnessHost(); await h.invoke("harness_genuinely_unknown_reader_command");
  assert.equal(h.harness.unstubbed.has("harness_genuinely_unknown_reader_command"), true);
  assert.equal(h.harness.stubsSinceMark[0], "harness_genuinely_unknown_reader_command");
});
