import assert from "node:assert/strict";
import test from "node:test";

import {
  chapterAtFraction,
  chaptersToTicks,
  clampFraction,
  fractionFromPointerX,
} from "../src/pages/reader/progress-scrubber-math.ts";

test("chaptersToTicks drops chapters without a sectionIndex", () => {
  const ticks = chaptersToTicks(
    [{ title: "Cover" }, { title: "Chapter 1", sectionIndex: 0 }],
    [0, 0.5],
  );
  assert.deepEqual(ticks, [{ fraction: 0, label: "Chapter 1" }]);
});

test("chaptersToTicks drops chapters whose sectionIndex has no fraction", () => {
  const ticks = chaptersToTicks([{ title: "Out of range", sectionIndex: 5 }], [0, 0.5]);
  assert.deepEqual(ticks, []);
});

test("chaptersToTicks sorts ticks by fraction", () => {
  const ticks = chaptersToTicks(
    [
      { title: "Chapter 2", sectionIndex: 1 },
      { title: "Chapter 1", sectionIndex: 0 },
    ],
    [0.1, 0.6],
  );
  assert.deepEqual(ticks, [
    { fraction: 0.1, label: "Chapter 1" },
    { fraction: 0.6, label: "Chapter 2" },
  ]);
});

test("clampFraction clamps to [0, 1] and rejects non-finite input", () => {
  assert.equal(clampFraction(-0.5), 0);
  assert.equal(clampFraction(1.5), 1);
  assert.equal(clampFraction(0.42), 0.42);
  assert.equal(clampFraction(Number.NaN), 0);
  assert.equal(clampFraction(Number.POSITIVE_INFINITY), 0);
});

test("fractionFromPointerX maps clientX within the rect to 0-1", () => {
  const rect = { left: 100, width: 200 };
  assert.equal(fractionFromPointerX(100, rect), 0);
  assert.equal(fractionFromPointerX(200, rect), 0.5);
  assert.equal(fractionFromPointerX(300, rect), 1);
});

test("fractionFromPointerX clamps outside the rect", () => {
  const rect = { left: 100, width: 200 };
  assert.equal(fractionFromPointerX(0, rect), 0);
  assert.equal(fractionFromPointerX(1000, rect), 1);
});

test("fractionFromPointerX returns 0 for a zero-width rect", () => {
  assert.equal(fractionFromPointerX(150, { left: 100, width: 0 }), 0);
});

test("chapterAtFraction returns the tick at or before the fraction", () => {
  const ticks = [
    { fraction: 0, label: "Ch 1" },
    { fraction: 0.5, label: "Ch 2" },
    { fraction: 0.8, label: "Ch 3" },
  ];
  assert.equal(chapterAtFraction(ticks, 0)?.label, "Ch 1");
  assert.equal(chapterAtFraction(ticks, 0.3)?.label, "Ch 1");
  assert.equal(chapterAtFraction(ticks, 0.5)?.label, "Ch 2");
  assert.equal(chapterAtFraction(ticks, 0.9)?.label, "Ch 3");
});

test("chapterAtFraction falls back to the first tick before any chapter starts", () => {
  const ticks = [
    { fraction: 0.2, label: "Ch 1" },
    { fraction: 0.7, label: "Ch 2" },
  ];
  assert.equal(chapterAtFraction(ticks, 0.05)?.label, "Ch 1");
});

test("chapterAtFraction returns undefined for an empty tick list", () => {
  assert.equal(chapterAtFraction([], 0.5), undefined);
});
