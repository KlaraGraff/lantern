import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_DISMISS_MS,
  PAGE_TURN_GRACE_MS,
  REARM_MS,
  isPageTurn,
  isRearmed,
  markDismissed,
  resetDismissals,
} from "../src/components/reading-strip-dismissal.ts";

test("a book nobody has dismissed gets greeted", () => {
  resetDismissals();
  assert.equal(isRearmed("book-a", 0), true);
});

test("dismissing holds the strip down for the re-arm window", () => {
  resetDismissals();
  markDismissed("book-a", 1_000);
  assert.equal(isRearmed("book-a", 1_000 + REARM_MS - 1), false);
});

test("re-entering the book long after a dismissal greets again", () => {
  resetDismissals();
  markDismissed("book-a", 1_000);
  assert.equal(isRearmed("book-a", 1_000 + REARM_MS), true);
});

test("dismissing one book says nothing about another", () => {
  resetDismissals();
  markDismissed("book-a", 1_000);
  assert.equal(isRearmed("book-b", 1_000), true);
});

test("the relocate foliate fires while laying out the first screen is not a page turn", () => {
  // Otherwise the strip dismisses itself before it has been painted once.
  assert.equal(isPageTurn(0, PAGE_TURN_GRACE_MS - 1), false);
});

test("a relocate after the grace window is a page turn", () => {
  assert.equal(isPageTurn(0, PAGE_TURN_GRACE_MS), true);
});

test("the page-turn grace window closes before the strip would leave on its own", () => {
  // If these crossed, a page turn could only ever dismiss a strip that had
  // already dismissed itself, and exit (b) would be dead code.
  assert.ok(PAGE_TURN_GRACE_MS < AUTO_DISMISS_MS);
});
