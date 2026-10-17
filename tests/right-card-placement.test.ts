import test from "node:test";
import assert from "node:assert/strict";
import { MIN_KEPT_MARGIN, placeRightCard } from "../src/pages/reader/right-card-placement.ts";

test("a right margin wide enough for the card keeps the page where it is", () => {
  // 1440 viewport, a 640px column centred: 400px margins. 404 needed.
  assert.deepEqual(placeRightCard(1600, { left: 480, right: 1120 }), { mode: "float", shift: 0 });
});

test("the text steps left by what the right margin lacks, if the left can spare it", () => {
  assert.deepEqual(placeRightCard(1280, { left: 320, right: 960 }), { mode: "float", shift: 84 });
});

test("the left margin keeps at least its minimum", () => {
  const right = 1280 - 100;
  const needed = 404 - 100;
  assert.equal(placeRightCard(1280, { left: needed + MIN_KEPT_MARGIN, right }).mode, "float");
  assert.equal(placeRightCard(1280, { left: needed + MIN_KEPT_MARGIN - 1, right }).mode, "pinned");
});

test("text that fills the page, as the default two columns do, makes the card sit down", () => {
  assert.deepEqual(placeRightCard(1280, { left: 24, right: 1256 }), { mode: "pinned" });
});

test("without a measurement the card sits down rather than risk covering text", () => {
  assert.deepEqual(placeRightCard(1280, null), { mode: "pinned" });
  assert.deepEqual(placeRightCard(0, { left: 0, right: 0 }), { mode: "pinned" });
});
