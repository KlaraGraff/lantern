import { test } from "node:test";
import assert from "node:assert/strict";
import { createSectionRetention } from "../public/foliate-js/section-retention.js";

function turnPages(pages: number, keep: number) {
  const unloaded: number[] = [];
  const retention = createSectionRetention({ keep, unload: (index: number) => unloaded.push(index) });
  // Two-page spreads, the way the paginated PDF renderer shows them.
  for (let left = 0; left < pages; left += 2) {
    retention.touch(left);
    retention.touch(left + 1);
    retention.trim(new Set([left, left + 1]));
  }
  return { retention, unloaded };
}

test("reading straight through keeps a fixed number of pages loaded", () => {
  const { retention, unloaded } = turnPages(400, 6);
  assert.equal(retention.size, 6);
  assert.equal(unloaded.length, 394);
  // Oldest pages go first, each exactly once.
  assert.deepEqual(unloaded.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(new Set(unloaded).size, unloaded.length);
});

test("turning back to a recent page reuses it instead of unloading it", () => {
  const unloaded: number[] = [];
  const retention = createSectionRetention({ keep: 4, unload: (index: number) => unloaded.push(index) });
  for (const page of [0, 1, 2, 3]) retention.touch(page);
  retention.touch(0); // back to the first page
  retention.touch(4);
  retention.trim(new Set([4]));
  assert.deepEqual(unloaded, [1]);
});

test("pages on screen are never unloaded, even when they are the oldest", () => {
  const unloaded: number[] = [];
  const retention = createSectionRetention({ keep: 1, unload: (index: number) => unloaded.push(index) });
  retention.touch(7);
  retention.touch(8);
  retention.touch(9);
  retention.trim(new Set([7, 8]));
  assert.deepEqual(unloaded, [9]);
  assert.equal(retention.size, 2);
});

test("blank slots of a spread are ignored", () => {
  const unloaded: number[] = [];
  const retention = createSectionRetention({ keep: 0, unload: (index: number) => unloaded.push(index) });
  retention.touch(-1);
  retention.trim(new Set());
  assert.equal(retention.size, 0);
  assert.deepEqual(unloaded, []);
});
