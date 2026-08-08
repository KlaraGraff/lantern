import assert from "node:assert/strict";
import test from "node:test";

import { resolveTabFocus } from "../src/components/focus-trap.ts";

// The ring is generic, so these stand in for real elements. What is under test
// is which end Tab lands on — the part that was copied into nine dialogs and
// covered by nothing.
const ring = ["first", "middle", "last"];

test("Tab off the last element wraps round to the first", () => {
  assert.deepEqual(resolveTabFocus(ring, "last", false), { kind: "focus", target: "first" });
});

test("Shift+Tab off the first element wraps round to the last", () => {
  assert.deepEqual(resolveTabFocus(ring, "first", true), { kind: "focus", target: "last" });
});

test("Tab anywhere in the middle is left to the browser", () => {
  assert.deepEqual(resolveTabFocus(ring, "middle", false), { kind: "pass" });
  assert.deepEqual(resolveTabFocus(ring, "middle", true), { kind: "pass" });
});

test("the wrap is driven by position, not by which end the key points at", () => {
  // Shift+Tab on the *last* element is an ordinary backwards step, not a wrap.
  assert.deepEqual(resolveTabFocus(ring, "last", true), { kind: "pass" });
  assert.deepEqual(resolveTabFocus(ring, "first", false), { kind: "pass" });
});

test("a dialog with one focusable control keeps focus on it in both directions", () => {
  const only = ["only"];
  assert.deepEqual(resolveTabFocus(only, "only", false), { kind: "focus", target: "only" });
  assert.deepEqual(resolveTabFocus(only, "only", true), { kind: "focus", target: "only" });
});

test("an empty ring lets Tab through, so a dialog with no controls is not a keyboard dead end", () => {
  assert.deepEqual(resolveTabFocus([], null, false), { kind: "pass" });
});

test("parkWhenEmpty holds focus on the container instead of letting Tab escape", () => {
  // SettingsModal: a section can legitimately render no controls, and the modal
  // itself carries tabIndex={-1} to catch focus in that case.
  assert.deepEqual(resolveTabFocus([], null, false, { parkWhenEmpty: true }), { kind: "park" });
  assert.deepEqual(resolveTabFocus(ring, "middle", false, { parkWhenEmpty: true }), { kind: "pass" });
});

test("focus that has escaped the container is pulled back to the near end", () => {
  assert.deepEqual(
    resolveTabFocus(ring, null, false, { focusInside: false }),
    { kind: "focus", target: "first" },
  );
  assert.deepEqual(
    resolveTabFocus(ring, null, true, { focusInside: false }),
    { kind: "focus", target: "last" },
  );
});

test("recovery beats the wrap check, so a stale activeElement cannot pin focus outside", () => {
  // `active` still points at an element that is no longer in the ring — what a
  // dismissed popover leaves behind. Without the recovery branch this would
  // fall through to "pass" and Tab would walk off into the page behind.
  assert.deepEqual(
    resolveTabFocus(ring, "gone", false, { focusInside: false }),
    { kind: "focus", target: "first" },
  );
});

test("without recovery, focus outside the ring is left alone", () => {
  // The default for the dialogs that never asked for recovery: Tab behaves
  // normally until focus is sitting on one of the two ends.
  assert.deepEqual(resolveTabFocus(ring, null, false), { kind: "pass" });
  assert.deepEqual(resolveTabFocus(ring, "gone", true), { kind: "pass" });
});
