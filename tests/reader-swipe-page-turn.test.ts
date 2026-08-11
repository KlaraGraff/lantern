import assert from "node:assert/strict";
import test from "node:test";

import {
  SWIPE_PAGE_TURN,
  createSwipeTracker,
  swipeDirection,
  swipePointerEligible,
} from "../src/pages/reader/swipe-page-turn.ts";
import {
  LONG_PRESS,
  longPressPointerEligible,
} from "../src/utils/long-press.ts";

const touch = (over: Partial<{ pointerType: string; isPrimary: boolean; button: number }> = {}) => ({
  pointerType: "touch",
  isPrimary: true,
  button: 0,
  ...over,
});

test("only a primary touch can swipe", () => {
  assert.equal(swipePointerEligible(touch()), true);
  assert.equal(swipePointerEligible(touch({ pointerType: "mouse" })), false);
  assert.equal(swipePointerEligible(touch({ pointerType: "pen" })), false);
  assert.equal(swipePointerEligible(touch({ isPrimary: false })), false);
  assert.equal(swipePointerEligible(touch({ button: 2 })), false);
});

// A mouse drag across text is a selection and must stay one; the reader's other
// page-turn inputs already cover every device that has them.
test("a mouse can never swipe, on any pointer", () => {
  for (const button of [0, 1, 2, 3, 4]) {
    for (const isPrimary of [false, true]) {
      assert.equal(swipePointerEligible({ pointerType: "mouse", isPrimary, button }), false);
    }
  }
});

test("swiping left pulls the next page in, swiping right goes back", () => {
  assert.equal(swipeDirection(-80, 0, 400), "next");
  assert.equal(swipeDirection(80, 0, 400), "previous");
});

test("a slow drag still turns once it is far enough", () => {
  assert.equal(swipeDirection(-60, 0, 5000), "next");
  assert.equal(swipeDirection(-59, 0, 5000), null);
});

test("a short flick turns, the same travel taken slowly does not", () => {
  assert.equal(swipeDirection(-30, 0, 200), "next");
  assert.equal(swipeDirection(-30, 0, 400), null);
});

// The reading motion in continuous flow is vertical, and a thumb travelling
// down the glass drifts sideways the whole way. Nothing on that arc may page.
test("a scroll never reads as a swipe, however far it drifts sideways", () => {
  for (let dy = 40; dy <= 400; dy += 20) {
    for (const drift of [-0.5, -0.25, 0.25, 0.5]) {
      assert.equal(swipeDirection(dy * drift, dy, 300), null);
    }
  }
});

test("a 45-degree drag is ambiguous and resolves to nothing", () => {
  assert.equal(swipeDirection(-100, 100, 200), null);
  assert.equal(swipeDirection(-100, 100, 5000), null);
});

test("travel below the flick distance is never a swipe, however fast", () => {
  assert.equal(swipeDirection(-29, 0, 1), null);
  assert.equal(swipeDirection(29, 0, 1), null);
});

test("one drag turns one page, however far the finger keeps going", () => {
  const tracker = createSwipeTracker();
  assert.equal(tracker.begin({ ...touch(), pointerId: 1, x: 300, y: 200 }, 0), true);
  assert.equal(tracker.move(1, 220, 205, 120), "next");
  assert.equal(tracker.phase, "turned");
  assert.equal(tracker.move(1, 100, 205, 200), null);
  assert.equal(tracker.move(1, 10, 205, 300), null);
});

test("a second drag turns again once the floor between turns has passed", () => {
  const tracker = createSwipeTracker();
  tracker.begin({ ...touch(), pointerId: 1, x: 300, y: 200 }, 0);
  assert.equal(tracker.move(1, 220, 200, 100), "next");
  tracker.cancel(1);

  // Inside the floor: tracked, but the turn is withheld.
  tracker.begin({ ...touch(), pointerId: 2, x: 300, y: 200 }, 200);
  assert.equal(tracker.move(2, 220, 200, 260), null);
  tracker.cancel(2);

  tracker.begin({ ...touch(), pointerId: 3, x: 300, y: 200 }, 500);
  assert.equal(tracker.move(3, 220, 200, 560), "next");
});

// A finger that rests long enough to open the selection menu and *then* drags
// would otherwise turn the page out from under the menu it just opened.
test("a long press that fired kills the swipe for that pointer", () => {
  const tracker = createSwipeTracker();
  tracker.begin({ ...touch(), pointerId: 1, x: 300, y: 200 }, 0);
  // Held still past the hold threshold — the menu opens, the caller cancels.
  assert.equal(tracker.move(1, 304, 203, LONG_PRESS.holdMs), null);
  tracker.cancel(1);
  assert.equal(tracker.phase, "cancelled");
  assert.equal(tracker.move(1, 180, 203, LONG_PRESS.holdMs + 200), null);
});

// Everything under `moveTolerancePx` keeps a long press alive; everything at or
// over `flickDistancePx` may swipe. The gap between them belongs to neither, so
// no single travel can be claimed by both gestures.
test("the two touch gestures cannot claim the same travel", () => {
  for (let dx = 0; dx <= 120; dx += 1) {
    const holdSurvives = dx < LONG_PRESS.moveTolerancePx;
    const canSwipe = swipeDirection(-dx, 0, 100) !== null;
    assert.equal(holdSurvives && canSwipe, false, `dx=${dx} claimed by both`);
  }
  assert.ok(LONG_PRESS.moveTolerancePx < SWIPE_PAGE_TURN.flickDistancePx);
});

// Long press takes touch and rejects mouse; swipe takes touch and rejects both
// mouse and pen. Neither may ever answer for a mouse, which is what keeps a
// touchscreen laptop's trackpad behaving like a trackpad.
test("neither touch gesture ever answers for a mouse", () => {
  for (const button of [0, 1, 2]) {
    const pointer = { pointerType: "mouse", isPrimary: true, button };
    assert.equal(longPressPointerEligible(pointer), false);
    assert.equal(swipePointerEligible(pointer), false);
  }
});

test("a move from another finger never steers this gesture", () => {
  const tracker = createSwipeTracker();
  tracker.begin({ ...touch(), pointerId: 1, x: 300, y: 200 }, 0);
  assert.equal(tracker.move(2, 100, 200, 100), null);
  assert.equal(tracker.phase, "tracking");
  assert.equal(tracker.move(1, 220, 200, 120), "next");
});

test("cancelling another pointer leaves this gesture alone", () => {
  const tracker = createSwipeTracker();
  tracker.begin({ ...touch(), pointerId: 1, x: 300, y: 200 }, 0);
  tracker.cancel(2);
  assert.equal(tracker.phase, "tracking");
  assert.equal(tracker.move(1, 220, 200, 120), "next");
});

test("an ineligible pointer is not tracked at all", () => {
  const tracker = createSwipeTracker();
  assert.equal(
    tracker.begin({ ...touch({ pointerType: "mouse" }), pointerId: 1, x: 300, y: 200 }, 0),
    false,
  );
  assert.equal(tracker.phase, "idle");
  assert.equal(tracker.move(1, 100, 200, 100), null);
});
