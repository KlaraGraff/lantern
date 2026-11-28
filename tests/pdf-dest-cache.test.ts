import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheDestResolver, prefetchOutline } from "../public/foliate-js/pdf.js";

test("each PDF destination is resolved once, however many callers ask", async () => {
  const calls: string[] = [];
  const resolve = cacheDestResolver(async (href: string) => {
    calls.push(href);
    return { index: Number(href) };
  });

  const [first, second] = await Promise.all([resolve("3"), resolve("3")]);
  assert.deepEqual(first, { index: 3 });
  assert.equal(second, first);
  assert.deepEqual(await resolve("3"), { index: 3 });
  assert.deepEqual(calls, ["3"]);
});

test("a failed destination is retried on the next call instead of staying failed", async () => {
  let attempts = 0;
  const resolve = cacheDestResolver(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("worker busy");
    return { index: 0 };
  });

  await assert.rejects(resolve("[0]"), /worker busy/);
  assert.deepEqual(await resolve("[0]"), { index: 0 });
  assert.equal(attempts, 2);
});

test("prefetching starts every outline entry at once, nested ones included", async () => {
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const resolve = cacheDestResolver((href: string) => {
    started.push(href);
    return new Promise((done) => pending.push(() => done({ index: 0 })));
  });

  prefetchOutline([
    { href: "a", subitems: [{ href: "a.1", subitems: null }, { href: undefined, subitems: null }] },
    { href: "b", subitems: null },
  ], resolve);
  await Promise.resolve();

  // All three are in flight before any has answered: the serial walk that
  // follows in view.open only awaits work already started.
  assert.deepEqual(started, ["a", "a.1", "b"]);
  for (const finish of pending) finish();
  await resolve("b");
  assert.deepEqual(started, ["a", "a.1", "b"]);
});
