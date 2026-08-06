import assert from "node:assert/strict";
import test from "node:test";

import {
  CLICK_COUNT_GRACE_MS,
  MULTI_CLICK_GRACE_MS,
  clickCountGraceMs,
} from "../src/pages/reader/click-grace.ts";

test("a double-click outlives the system multi-click window", () => {
  assert.equal(clickCountGraceMs(2, true), MULTI_CLICK_GRACE_MS);
  // The wait only buys anything if it is longer than the short grace a third
  // click used to beat, and long enough to cover a system interval near 500ms.
  assert.ok(MULTI_CLICK_GRACE_MS > CLICK_COUNT_GRACE_MS);
  assert.ok(MULTI_CLICK_GRACE_MS >= 400);
});

test("a double-click stays fast when no third click can claim the gesture", () => {
  assert.equal(clickCountGraceMs(2, false), CLICK_COUNT_GRACE_MS);
});

test("a single click never waits out the multi-click window", () => {
  assert.equal(clickCountGraceMs(1, true), CLICK_COUNT_GRACE_MS);
  assert.equal(clickCountGraceMs(1, false), CLICK_COUNT_GRACE_MS);
});

test("counts past the third click keep the short grace", () => {
  assert.equal(clickCountGraceMs(3, true), CLICK_COUNT_GRACE_MS);
  assert.equal(clickCountGraceMs(4, true), CLICK_COUNT_GRACE_MS);
});
