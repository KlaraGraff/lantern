import assert from "node:assert/strict";
import test from "node:test";
import {
  cardPosition,
  clampCardPoint,
  marginDock,
} from "../src/components/learning-card/placement.ts";

// `cardPosition` reads `window.innerHeight` for its height cap. Nothing here is
// testing that cap, so a stub window is enough — and stating it once keeps the
// cases below about geometry.
(globalThis as { window?: unknown }).window = { innerWidth: 1440, innerHeight: 900 };

/** A 1440×900 reader with the text column capped and centred: 420px blank each side. */
const READER = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
const TEXT = { left: 420, top: 0, right: 1020, bottom: 900, width: 600, height: 900 };

/** A word part-way down the first line of the column. */
const word = (left: number, top = 300) => ({
  anchorRect: { left, top, right: left + 60, bottom: top + 20, width: 60, height: 20 },
});

test("a card that fits the blank right margin stands in it, not over the text", () => {
  // 1440 - 1020 = 420 of blank, and 380 + 12 + 12 = 404 needed.
  assert.equal(marginDock(READER, TEXT, 380), 1032);
  const placed = cardPosition(word(500), READER, 380, 0, TEXT);
  assert.equal(placed.left, 1032);
  assert.ok(placed.left >= TEXT.right, "card starts past the end of the text");
});

test("the side is the one with room, not always the right", () => {
  // The AI panel is open, so the reader viewport ends at 1000 and the right
  // margin is gone. The left one is untouched and takes the card.
  const narrowed = { ...READER, right: 1000, width: 1000 };
  assert.equal(marginDock(narrowed, TEXT, 380), 420 - 12 - 380);
  const placed = cardPosition(word(500), narrowed, 380, 0, TEXT);
  assert.equal(placed.left + 380, TEXT.left - 12, "card ends before the text starts");
});

test("neither margin holding the card falls back to opening beside the word", () => {
  // A 560px card needs 584 and neither 420px strip has it.
  assert.equal(marginDock(READER, TEXT, 560), null);
  const anchor = word(500);
  const placed = cardPosition(anchor, READER, 560, 0, TEXT);
  assert.equal(placed.left, anchor.anchorRect.right + 8);
});

test("with no page rect the card behaves exactly as it did before", () => {
  const anchor = word(500);
  assert.equal(marginDock(READER, null, 380), null);
  assert.deepEqual(
    cardPosition(anchor, READER, 380, 0, null),
    cardPosition(anchor, READER, 380, 0),
  );
});

test("where in the line the word sits does not move a docked card", () => {
  // The reason the dock prefers a fixed side: picking the nearer one would
  // throw the card across the page depending on where the click landed.
  const first = cardPosition(word(430), READER, 380, 0, TEXT).left;
  const last = cardPosition(word(950), READER, 380, 0, TEXT).left;
  assert.equal(first, last);
});

test("a docked card cascades down but not sideways", () => {
  const first = cardPosition(word(500), READER, 380, 0, TEXT);
  const third = cardPosition(word(500), READER, 380, 2, TEXT);
  assert.equal(third.left, first.left, "stepping right would walk back onto the text");
  assert.equal(third.top, first.top + 44);
});

test("an undocked card still cascades in both directions", () => {
  const first = cardPosition(word(500), READER, 560, 0, TEXT);
  const third = cardPosition(word(500), READER, 560, 2, TEXT);
  assert.equal(third.left, first.left + 44);
  assert.equal(third.top, first.top + 44);
});

test("dragging still cannot push a card out of the reader", () => {
  assert.deepEqual(
    clampCardPoint({ left: 5000, top: -400 }, READER, 380, 500),
    { left: 1440 - 380 - 12, top: 12 },
  );
});
