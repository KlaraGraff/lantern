import test from "node:test";
import assert from "node:assert/strict";
import { pickReadAloudStart, type SentenceBoundaries } from "../src/pages/reader/read-aloud-start.ts";

// The comparisons the source feeds in are DOM boundary-point signs. Spelling
// them as "this sentence lives entirely before / across / after the page start"
// keeps the cases readable.
const before = (): SentenceBoundaries => ({ startVsPage: -1, endVsPage: -1 });
const spills = (): SentenceBoundaries => ({ startVsPage: -1, endVsPage: 1 });
const atTop = (): SentenceBoundaries => ({ startVsPage: 0, endVsPage: 1 });
const after = (): SentenceBoundaries => ({ startVsPage: 1, endVsPage: 1 });

test("picks the first sentence that begins on the page, not the one spilling onto it", () => {
  assert.deepEqual(
    pickReadAloudStart([before(), spills(), after(), after()]),
    { kind: "sentence", index: 2 },
  );
});

test("a sentence starting exactly at the page's first character is on the page", () => {
  assert.deepEqual(
    pickReadAloudStart([before(), atTop(), after()]),
    { kind: "sentence", index: 1 },
  );
});

test("a page that is one long sentence's middle reads that sentence, flagged as a continuation", () => {
  // Nothing begins here, so there is no forward choice; the caller reads the
  // sentence on screen but must not navigate to its start on an earlier page.
  assert.deepEqual(
    pickReadAloudStart([before(), spills()]),
    { kind: "continuation", index: 1 },
  );
});

test("a sentence ending exactly at the page start has nothing on screen and is not a continuation", () => {
  assert.deepEqual(
    pickReadAloudStart([{ startVsPage: -1, endVsPage: 0 }]),
    { kind: "none" },
  );
});

test("a section whose sentences all end before the page yields nothing to start with", () => {
  assert.deepEqual(pickReadAloudStart([before(), before()]), { kind: "none" });
});

test("an empty section yields nothing", () => {
  assert.deepEqual(pickReadAloudStart([]), { kind: "none" });
});

test("the very first page of a section starts at its very first sentence", () => {
  assert.deepEqual(
    pickReadAloudStart([atTop(), after(), after()]),
    { kind: "sentence", index: 0 },
  );
});

test("never selects a sentence earlier than the one that spills, so playback cannot go backwards", () => {
  const choice = pickReadAloudStart([before(), before(), spills(), after()]);
  assert.equal(choice.kind, "sentence");
  assert.equal(choice.kind === "sentence" && choice.index, 3);
});
