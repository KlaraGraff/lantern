import assert from "node:assert/strict";
import test from "node:test";

import {
  LONG_PRESS,
  createLongPressTracker,
  longPressPointerEligible,
  longPressTravelExceeded,
} from "../src/utils/long-press.ts";
import { bindingFromMouseEvent } from "../src/components/reader-bindings.ts";

const touch = (over: Partial<{
  pointerId: number;
  pointerType: string;
  button: number;
  isPrimary: boolean;
  x: number;
  y: number;
}> = {}) => ({
  pointerId: 1,
  pointerType: "touch",
  button: 0,
  isPrimary: true,
  x: 100,
  y: 100,
  ...over,
});

test("the hold is long enough to outlast a tap and short enough to feel native", () => {
  assert.ok(LONG_PRESS.holdMs >= 400);
  assert.ok(LONG_PRESS.holdMs <= 600);
  // The click guard has to survive the pointerup→click gap, so it must outlast
  // nothing in particular — but a guard shorter than the hold itself could be
  // beaten by the very click it exists to swallow.
  assert.ok(LONG_PRESS.clickSuppressionMs > LONG_PRESS.holdMs / 2);
});

test("a finger that stays put inside the tolerance still opens the menu", () => {
  const tracker = createLongPressTracker();
  assert.equal(tracker.begin(touch()), true);
  assert.equal(tracker.move(1, 106, 100), false);
  assert.equal(tracker.move(1, 103, 105), false);
  assert.equal(tracker.phase, "pending");
  assert.equal(tracker.hold(1), true);
  assert.equal(tracker.phase, "triggered");
});

test("travel past the tolerance is a drag, and the hold never fires", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  assert.equal(tracker.move(1, 100, 111), true);
  assert.equal(tracker.phase, "cancelled");
  // The timer still runs out — the tracker is what refuses, not the clock.
  assert.equal(tracker.hold(1), false);
});

test("the tolerance is measured as distance, not per axis", () => {
  // 7px on each axis is 9.9px of travel: inside the tolerance, even though a
  // per-axis test at 10 would also pass it and a per-axis test at 7 would not.
  assert.equal(longPressTravelExceeded({ x: 0, y: 0 }, 7, 7), false);
  assert.equal(longPressTravelExceeded({ x: 0, y: 0 }, 8, 8), true);
  assert.equal(longPressTravelExceeded({ x: 0, y: 0 }, 0, 10), true);
  assert.equal(longPressTravelExceeded({ x: 0, y: 0 }, 0, 9.99), false);
});

test("a scroll moving some other pointer cannot cancel this hold", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch({ pointerId: 4 }));
  // A second finger travelling far must not report a cancellation, or the
  // reader would drop the timer for the finger that is still holding still.
  assert.equal(tracker.move(9, 900, 900), false);
  assert.equal(tracker.phase, "pending");
  assert.equal(tracker.hold(4), true);
});

test("a press that already ended cannot be revived by a late timer", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  tracker.cancel();
  assert.equal(tracker.hold(1), false);
});

test("a mouse never long-presses, however coarse the device claims to be", () => {
  // A trackpad on a touchscreen laptop reports `(pointer: coarse)` for the
  // panel and still sends `mouse` pointers with a working contextmenu.
  assert.equal(longPressPointerEligible({ pointerType: "mouse", button: 0, isPrimary: true }), false);
  assert.equal(longPressPointerEligible({ pointerType: "touch", button: 0, isPrimary: true }), true);
  assert.equal(longPressPointerEligible({ pointerType: "pen", button: 0, isPrimary: true }), true);
  const tracker = createLongPressTracker();
  assert.equal(tracker.begin(touch({ pointerType: "mouse" })), false);
  assert.equal(tracker.hold(1), false);
});

test("long press and click-to-turn-page can never claim the same pointer", () => {
  // Page turns are bound by `bindingFromMouseEvent`, which refuses button 0 —
  // so every button a page-turn binding can name is a button the long press
  // declines, and vice versa. Asserted as the property rather than as two
  // hand-picked buttons, so a change to either side has to break this.
  for (const button of [0, 1, 2, 3, 4]) {
    const bindable = bindingFromMouseEvent({ button } as MouseEvent) !== null;
    const holdable = longPressPointerEligible({ pointerType: "touch", button, isPrimary: true });
    assert.equal(holdable, !bindable, `button ${button}`);
  }
});

test("a non-primary pointer — the second finger of a pinch — never holds", () => {
  assert.equal(longPressPointerEligible({ pointerType: "touch", button: 0, isPrimary: false }), false);
});

test("the click that trails a triggered press is swallowed exactly once", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  tracker.hold(1);
  tracker.suppressClick(1_000);
  // The pointerup that ends the gesture must not disarm the guard: the click it
  // guards against has not arrived yet.
  tracker.cancel();
  assert.equal(tracker.consumeClick(1_050), true);
  assert.equal(tracker.consumeClick(1_060), false);
});

test("a click that never came does not swallow the next tap", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  tracker.hold(1);
  tracker.suppressClick(1_000);
  // WebKit skips the synthetic click when a press ends on a selection, so the
  // guard has to expire on its own rather than wait to be consumed.
  assert.equal(tracker.consumeClick(1_000 + LONG_PRESS.clickSuppressionMs), false);
});

test("a new press disarms a guard the previous one left behind", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  tracker.hold(1);
  tracker.suppressClick(1_000);
  tracker.begin(touch({ pointerId: 2 }));
  assert.equal(tracker.consumeClick(1_050), false);
});

test("a press that opened nothing leaves the following tap alone", () => {
  const tracker = createLongPressTracker();
  tracker.begin(touch());
  tracker.hold(1);
  // `suppressClick` is called by the reader only once a menu actually opened —
  // a hold over blank margin resolves to no range and arms nothing.
  assert.equal(tracker.consumeClick(1_050), false);
});
