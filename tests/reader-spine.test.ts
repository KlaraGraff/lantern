import test from "node:test";
import assert from "node:assert/strict";
import { spineSegments } from "../src/pages/reader/reader-spine.ts";

const CHAPTERS = [
  { title: "Cover", depth: 0, sectionIndex: 0 },
  { title: "One", depth: 0, sectionIndex: 1 },
  { title: "One, part two", depth: 1, sectionIndex: 2 },
  { title: "Two", depth: 0, sectionIndex: 3 },
];
const FRACTIONS = [0, 0.1, 0.3, 0.6, 1];

test("one segment per top-level chapter, from its section's start to the next", () => {
  const segments = spineSegments(CHAPTERS, FRACTIONS, 0);
  assert.deepEqual(segments.map((s) => [s.title, s.start, s.end]), [
    ["Cover", 0, 0.1],
    ["One", 0.1, 0.6],
    ["Two", 0.6, 1],
  ]);
});

test("segments behind the reader are full, the current one part-filled, the rest empty", () => {
  const segments = spineSegments(CHAPTERS, FRACTIONS, 35);
  assert.deepEqual(segments.map((s) => s.fill), [1, 0.5, 0]);
  assert.deepEqual(segments.map((s) => s.current), [false, true, false]);
});

test("front matter before the first chapter belongs to it", () => {
  const segments = spineSegments(CHAPTERS.slice(1), FRACTIONS, 5);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].current, true);
});

test("the end of the book is inside the last chapter", () => {
  const segments = spineSegments(CHAPTERS, FRACTIONS, 100);
  assert.deepEqual(segments.map((s) => s.fill), [1, 1, 1]);
  assert.equal(segments[2].current, true);
});

test("entries out of order or sharing a section collapse into the first", () => {
  const segments = spineSegments([
    { title: "A", depth: 0, sectionIndex: 1 },
    { title: "A again", depth: 0, sectionIndex: 1 },
    { title: "Before A", depth: 0, sectionIndex: 0 },
    { title: "B", depth: 0, sectionIndex: 3 },
  ], FRACTIONS, 0);
  assert.deepEqual(segments.map((s) => s.title), ["A", "B"]);
});

test("without section fractions the spine is the whole book", () => {
  assert.deepEqual(spineSegments(CHAPTERS, [], 42), [{ start: 0, end: 1, fill: 0.42, current: true, title: "" }]);
  assert.deepEqual(spineSegments([], FRACTIONS, Number.NaN)[0].fill, 0);
});
