import assert from "node:assert/strict";
import test from "node:test";

import {
  FADE_AFTER_PAGE_TURNS,
  advanceFadeCounter,
  armFadeCounter,
  initialFadeCounter,
  popEntry,
  pushEntry,
  topLabel,
  type JumpHistoryEntry,
} from "../src/pages/reader/useJumpHistory.ts";

const entry = (n: number): JumpHistoryEntry => ({ location: `cfi-${n}`, label: `Chapter ${n}` });

test("pushEntry appends without mutating the base", () => {
  const base = [entry(1)];
  const pushed = pushEntry(base, entry(2));
  assert.deepEqual(pushed, [entry(1), entry(2)]);
  assert.deepEqual(base, [entry(1)]);
});

test("popEntry removes and returns the top entry", () => {
  const { stack, popped } = popEntry([entry(1), entry(2)]);
  assert.deepEqual(stack, [entry(1)]);
  assert.deepEqual(popped, entry(2));
});

test("popEntry on an empty stack returns undefined and an empty stack", () => {
  const { stack, popped } = popEntry([]);
  assert.deepEqual(stack, []);
  assert.equal(popped, undefined);
});

test("topLabel reads the most recently pushed entry's label", () => {
  assert.equal(topLabel([]), null);
  assert.equal(topLabel([entry(1), entry(2)]), "Chapter 2");
});

test("a fresh fade counter never suppresses and starts at zero", () => {
  const counter = initialFadeCounter();
  assert.equal(counter.turnsSincePush, 0);
  assert.equal(counter.suppressNext, false);
});

test("arming after a push or return suppresses exactly the next update", () => {
  const armed = armFadeCounter();
  const { counter, visible } = advanceFadeCounter(armed);
  // The jump's own relocate doesn't count against the fade budget.
  assert.equal(visible, true);
  assert.equal(counter.turnsSincePush, 0);
  assert.equal(counter.suppressNext, false);
});

test("the pill survives FADE_AFTER_PAGE_TURNS ordinary turns, then fades", () => {
  let counter = armFadeCounter();
  // The suppressed update right after the jump itself.
  ({ counter } = advanceFadeCounter(counter));
  let visible: boolean;
  for (let i = 0; i < FADE_AFTER_PAGE_TURNS - 1; i += 1) {
    ({ counter, visible } = advanceFadeCounter(counter));
    assert.equal(visible, true, `still visible after ${i + 1} turn(s)`);
  }
  ({ visible } = advanceFadeCounter(counter));
  assert.equal(visible, false);
});

test("a new push re-arms the counter even mid-fade", () => {
  let counter = armFadeCounter();
  ({ counter } = advanceFadeCounter(counter)); // consume the suppressed post-push update
  for (let i = 0; i < FADE_AFTER_PAGE_TURNS - 1; i += 1) {
    ({ counter } = advanceFadeCounter(counter));
  }
  // One more turn would fade it; a fresh jump arrives first instead.
  counter = armFadeCounter();
  const { visible } = advanceFadeCounter(counter);
  assert.equal(visible, true);
});
