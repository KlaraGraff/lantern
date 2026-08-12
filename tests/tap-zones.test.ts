import assert from "node:assert/strict";
import test from "node:test";

import { classifyReaderTap, classifyReaderTapInBox } from "../src/pages/reader/tap-zones.ts";

test("the page splits in three equal columns", () => {
  const width = 390;
  assert.equal(classifyReaderTap(10, width), "previous");
  assert.equal(classifyReaderTap(129, width), "previous");
  assert.equal(classifyReaderTap(130, width), "menu");
  assert.equal(classifyReaderTap(195, width), "menu");
  assert.equal(classifyReaderTap(259, width), "menu");
  assert.equal(classifyReaderTap(260, width), "next");
  assert.equal(classifyReaderTap(389, width), "next");
});

// The boundaries belong to a definite zone whatever the width, so no tap can
// fall through to "nothing happened" — the outcome a reader reads as a broken
// page rather than as a miss.
test("every point on the page belongs to exactly one zone", () => {
  for (const width of [1, 2, 3, 320, 375, 390, 428, 1024]) {
    for (let x = 0; x < width; x += 1) {
      const zone = classifyReaderTap(x, width);
      assert.ok(
        zone === "previous" || zone === "menu" || zone === "next",
        `x=${x} width=${width} produced ${zone}`,
      );
    }
  }
});

test("the zones stay in reading order across the width", () => {
  const width = 300;
  const zones = Array.from({ length: width }, (_, x) => classifyReaderTap(x, width));
  assert.equal(zones.indexOf("menu") > zones.lastIndexOf("previous"), true);
  assert.equal(zones.indexOf("next") > zones.lastIndexOf("menu"), true);
});

test("a tap past either edge falls back to the nearest zone", () => {
  assert.equal(classifyReaderTap(-0.4, 390), "previous");
  assert.equal(classifyReaderTap(-1000, 390), "previous");
  assert.equal(classifyReaderTap(390, 390), "next");
  assert.equal(classifyReaderTap(1000, 390), "next");
});

// One-handed mode redirects only the left zone: forward is the tap every grip
// can make, backward stays on the swipe, and the middle third still raises the
// chrome so the menu is never out of reach.
test("one-handed mode turns the left zone into another next", () => {
  const width = 390;
  assert.equal(classifyReaderTap(10, width, true), "next");
  assert.equal(classifyReaderTap(129, width, true), "next");
  assert.equal(classifyReaderTap(195, width, true), "menu");
  assert.equal(classifyReaderTap(389, width, true), "next");
  assert.equal(classifyReaderTap(120, 0, true), "menu");
});

// The text reader is not in an iframe, so its clientX carries whatever sits to
// the left of the page. A box offset by 40px has to split at 40/113/187, not at
// 0/113/226 — otherwise the left third of a landscape phone's page turns
// forward and the right third does nothing.
test("a tap in the host document is measured against the page box, not the window", () => {
  const box = { left: 40, width: 300 };
  assert.equal(classifyReaderTapInBox(40, box), "previous");
  assert.equal(classifyReaderTapInBox(139, box), "previous");
  assert.equal(classifyReaderTapInBox(140, box), "menu");
  assert.equal(classifyReaderTapInBox(239, box), "menu");
  assert.equal(classifyReaderTapInBox(240, box), "next");
  assert.equal(classifyReaderTapInBox(339, box), "next");
});

test("the boxed split answers the same as the raw one when the box starts at zero", () => {
  const width = 375;
  for (let x = 0; x < width; x += 1) {
    for (const oneHand of [false, true]) {
      assert.equal(
        classifyReaderTapInBox(x, { left: 0, width }, oneHand),
        classifyReaderTap(x, width, oneHand),
        `x=${x} oneHand=${oneHand}`,
      );
    }
  }
});

test("a tap outside the page box clamps to the box's nearest zone", () => {
  const box = { left: 40, width: 300 };
  assert.equal(classifyReaderTapInBox(0, box), "previous");
  assert.equal(classifyReaderTapInBox(-500, box), "previous");
  assert.equal(classifyReaderTapInBox(340, box), "next");
  assert.equal(classifyReaderTapInBox(5000, box), "next");
  assert.equal(classifyReaderTapInBox(0, box, true), "next");
});

test("an unmeasured page box raises the menu rather than paging", () => {
  assert.equal(classifyReaderTapInBox(120, { left: 0, width: 0 }), "menu");
  assert.equal(classifyReaderTapInBox(120, { left: Number.NaN, width: 300 }), "menu");
  assert.equal(classifyReaderTapInBox(120, { left: 0, width: Number.NaN }), "menu");
});

// A page that has not laid out yet reports zero width. Dividing by it would
// hand back "next" for every tap, i.e. a reader poking a blank screen would
// silently page forward through the book.
test("an unmeasured page raises the menu rather than paging", () => {
  assert.equal(classifyReaderTap(120, 0), "menu");
  assert.equal(classifyReaderTap(120, -5), "menu");
  assert.equal(classifyReaderTap(120, Number.NaN), "menu");
  assert.equal(classifyReaderTap(Number.NaN, 390), "menu");
});
