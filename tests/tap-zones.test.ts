import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReaderTap,
  classifyReaderTapInBox,
  frameClientXToHost,
} from "../src/pages/reader/tap-zones.ts";

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

// Paginated flow: foliate's iframe is the whole chapter laid out side by side,
// scrolled so the current page fills the screen. On page 3 of a 440pt-wide
// phone the frame's host box starts at -880, so a tap the reader sees at 380
// arrives as clientX 1260 — the mapping has to give the on-screen 380 back.
test("a tap inside the paginated chapter frame maps back to the page on screen", () => {
  const frame = { left: -880, width: 8800 };
  assert.equal(frameClientXToHost(1260, frame, 8800), 380);
  const box = { left: 0, width: 440 };
  assert.equal(classifyReaderTapInBox(frameClientXToHost(1260, frame, 8800), box), "next");
  assert.equal(classifyReaderTapInBox(frameClientXToHost(950, frame, 8800), box), "previous");
  assert.equal(classifyReaderTapInBox(frameClientXToHost(1100, frame, 8800), box), "menu");
});

// The regression this mapping exists for: on the first page of a 20-page
// chapter the frame sits at 0 and the old math cut thirds from all 8800px, so
// a tap at 380 — the right zone of the visible page — classified as
// "previous" and bounced the reader back into the previous section.
test("a right-zone tap on a long chapter's first page turns forward, not back", () => {
  const frame = { left: 0, width: 8800 };
  const box = { left: 0, width: 440 };
  assert.equal(frameClientXToHost(380, frame, 8800), 380);
  assert.equal(classifyReaderTapInBox(frameClientXToHost(380, frame, 8800), box), "next");
  assert.equal(classifyReaderTap(380, 8800), "previous");
});

// Fixed-layout books draw the frame at a different size than its document —
// the ratio carries the tap through the scale.
test("a scaled frame maps its taps through the on-screen size", () => {
  assert.equal(frameClientXToHost(600, { left: 0, width: 400 }, 800), 300);
  assert.equal(frameClientXToHost(100, { left: 50, width: 400 }, 800), 100);
});

// In scrolled flow the frame is the page at scale 1 — the mapping must be the
// identity so the zones stay exactly where they were before it existed.
test("the frame mapping is the identity in scrolled flow", () => {
  const frame = { left: 0, width: 440 };
  for (const x of [0, 70, 220, 380, 439]) {
    assert.equal(frameClientXToHost(x, frame, 440), x);
  }
});

test("an unmeasured frame leaves the coordinate alone", () => {
  assert.equal(frameClientXToHost(120, { left: 0, width: 0 }, 800), 120);
  assert.equal(frameClientXToHost(120, { left: 0, width: 400 }, 0), 120);
  assert.equal(frameClientXToHost(120, { left: 0, width: 400 }, Number.NaN), 120);
});
