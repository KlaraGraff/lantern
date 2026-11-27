import assert from "node:assert/strict";
import test from "node:test";

import { planTextHighlightMutation } from "../src/components/highlight-ranges.ts";

const yellow = (id: string, start: number, end: number) => ({
  id,
  cfi_range: `textloc:v2:${start}:${end}`,
  color: "yellow",
  text_content: null,
});

// Highlighting 10–20 grows the range to 5 through [5,12]; only then does
// [0,5] touch it. [15,18] comes later in the same pass and grows nothing,
// which used to reset the "changed" flag and end the merge one pass early,
// leaving [0,5] as a separate, now-adjacent highlight.
test("a range reachable only after an earlier merge in the pass is still merged", () => {
  const plan = planTextHighlightMutation(
    "textloc:v2:10:20",
    [yellow("c", 0, 5), yellow("a", 5, 12), yellow("b", 15, 18)],
    "yellow",
  );
  assert.ok(plan);
  assert.deepEqual([...plan.removeIds].sort(), ["a", "b", "c"]);
  assert.deepEqual(plan.additions, [
    { cfiRange: "textloc:v2:0:20", color: "yellow", textContent: null },
  ]);
});
