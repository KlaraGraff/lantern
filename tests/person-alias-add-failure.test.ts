import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * `PersonAliasesSection` is a component, so its add handlers cannot be mounted
 * here. What can be pinned is the shape the bug lived in: `run` swallowed the
 * failure into the error band, and the add forms closed on `.then` regardless,
 * so a failed add threw away what the reader had just typed.
 */
const source = readFileSync(
  path.join(import.meta.dirname, "../src/components/PersonAliasesSection.tsx"),
  "utf8",
);

const slice = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not find ${from}`);
  return source.slice(start, end);
};

test("run reports whether the action went through", () => {
  const run = slice("const run = async (", "const building =");
  assert.match(run, /return done;/);
  // Set only after the action resolves: a failure leaves it false.
  assert.ok(run.indexOf("await action();") < run.indexOf("done = true;"));
});

for (const [name, cancel] of [
  ["submitAddAlias", "cancelAddAlias"],
  ["submitAddPerson", "cancelAddPerson"],
] as const) {
  test(`${name} keeps the form and its text when the add fails`, () => {
    const handler = slice(`const ${name} = (`, "};\n");
    assert.doesNotMatch(handler, new RegExp(`\\.then\\(${cancel}\\)`), "closes even on failure");
    assert.match(handler, new RegExp(`\\.then\\(\\(done\\) => \\{ if \\(done\\) ${cancel}\\(\\); \\}\\)`));
  });
}
