import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeInteractionText,
  rangeFromSelectionSnapshotAtPoint,
  readerMenuActivationIndex,
  readerMenuFocusIndex,
  segmentInteractionWords,
  withInheritedContext,
  type ReaderInteraction,
} from "../src/components/reader-interaction.ts";

const words = (value: string, locale = "en") => (
  segmentInteractionWords(value, locale).map(({ segment }) => segment)
);

test("keeps apostrophes and hyphens inside interaction words", () => {
  assert.deepEqual(words("don't teacher's well-known"), ["don't", "teacher's", "well-known"]);
});

test("normalizes decomposed accents to NFC", () => {
  assert.equal(normalizeInteractionText("  Cafe\u0301!  "), "cafe\u0301".normalize("NFC"));
});

test("segments CJK without dropping characters", () => {
  assert.equal(words("\u4f60\u597d\u4e16\u754c", "zh").join(""), "\u4f60\u597d\u4e16\u754c");
});

test("rejects punctuation and whitespace", () => {
  assert.deepEqual(words("  ... -- !  "), []);
  assert.equal(normalizeInteractionText("  ... -- !  "), "");
});

test("reuses a snapshotted passage when a click lands inside its selection", () => {
  const clonedRange = { id: "selected-passage" };
  let rects = [
    { left: 10, top: 20, right: 110, bottom: 40 },
    { left: 10, top: 40, right: 70, bottom: 60 },
  ];
  const range = {
    cloneRange: () => clonedRange,
    getClientRects: () => rects,
  } as unknown as Range;
  const snapshot = { range };

  assert.equal(rangeFromSelectionSnapshotAtPoint(snapshot, 50, 50), clonedRange);
  assert.equal(rangeFromSelectionSnapshotAtPoint(snapshot, 120, 50), null);

  rects = [{ left: 10, top: 120, right: 110, bottom: 140 }];
  assert.equal(rangeFromSelectionSnapshotAtPoint(snapshot, 50, 50), null);
  assert.equal(rangeFromSelectionSnapshotAtPoint(snapshot, 50, 130), clonedRange);
});

test("moves keyboard focus into an unfocused selection menu without stealing it on open", () => {
  assert.equal(readerMenuFocusIndex("ArrowDown", -1, 4), 0);
  assert.equal(readerMenuFocusIndex("ArrowUp", -1, 4), 3);
  assert.equal(readerMenuFocusIndex("Home", 2, 4), 0);
  assert.equal(readerMenuFocusIndex("End", 1, 4), 3);
  assert.equal(readerMenuFocusIndex("ArrowDown", 3, 4), 0);
  assert.equal(readerMenuFocusIndex("ArrowUp", 0, 4), 3);
  assert.equal(readerMenuFocusIndex("Tab", -1, 4), 0);
  assert.equal(readerMenuFocusIndex("Tab", -1, 4, true), 3);
  assert.equal(readerMenuFocusIndex("Tab", 0, 4), null);
  assert.equal(readerMenuFocusIndex("ArrowDown", -1, 4, true), null);
  assert.equal(readerMenuFocusIndex("ArrowDown", -1, 4, false, true), null);
  assert.equal(readerMenuActivationIndex("Enter", -1, 4), 0);
  assert.equal(readerMenuActivationIndex(" ", -1, 4), 0);
  assert.equal(readerMenuActivationIndex("Enter", 0, 4), null);
  assert.equal(readerMenuActivationIndex("Enter", -1, 4, true), null);
});

const interaction = (text: string, context: string, location = ""): ReaderInteraction => ({
  trigger: "word-quick-lookup",
  kind: "word",
  text,
  normalizedText: normalizeInteractionText(text),
  context,
  location,
  anchorRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  source: "text",
  format: "text",
});

const PASSAGE = "He had a penchant for Spoiling his grandchildren with trips to the fairground.";

test("a lookup inside a card reads the book passage the card is about", () => {
  const nested = interaction("spoiling", "spoil the mood");
  const origin = interaction("penchant", PASSAGE, "epubcfi(/6/14!/4/2)");
  const inherited = withInheritedContext(nested, origin);

  assert.equal(inherited.context, PASSAGE);
  // The parent's position addresses "penchant", so carrying it over would mark
  // the wrong occurrence and file the lookup at the wrong place in the book.
  assert.equal(inherited.location, "");
});

test("a word the passage does not contain keeps the context around it", () => {
  const nested = interaction("Contextual", "Contextual meaning");
  const inherited = withInheritedContext(nested, interaction("penchant", PASSAGE));
  assert.equal(inherited.context, "Contextual meaning");
});

test("a lookup with no card behind it is left alone", () => {
  const nested = interaction("spoiling", "spoil the mood");
  assert.equal(withInheritedContext(nested, undefined), nested);
  assert.equal(withInheritedContext(nested, interaction("penchant", "   ")), nested);
});
