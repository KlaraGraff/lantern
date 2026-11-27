import test from "node:test";
import assert from "node:assert/strict";
import { canFoldWithPage, foldedEar, isAnchorOffPage } from "../src/pages/reader/answer-fold.ts";
import type { ReaderInteraction } from "../src/components/reader-interaction.ts";

const onPage = { startVsVisibleEnd: -1, endVsVisibleStart: 1 };

test("a sentence still on the page keeps its card", () => {
  assert.equal(isAnchorOffPage(onPage), false);
});

test("a sentence turned past folds its card", () => {
  // Ends before the page starts (turned forward past it).
  assert.equal(isAnchorOffPage({ startVsVisibleEnd: -1, endVsVisibleStart: -1 }), true);
  // Starts after the page ends (turned back before it).
  assert.equal(isAnchorOffPage({ startVsVisibleEnd: 1, endVsVisibleStart: 1 }), true);
});

test("touching the page's edge is not being on it", () => {
  assert.equal(isAnchorOffPage({ startVsVisibleEnd: 0, endVsVisibleStart: 1 }), true);
  assert.equal(isAnchorOffPage({ startVsVisibleEnd: -1, endVsVisibleStart: 0 }), true);
});

test("a sentence in another chapter folds its card", () => {
  assert.equal(isAnchorOffPage("other-chapter"), true);
});

test("a sentence that cannot be placed never hides a card on a guess", () => {
  assert.equal(isAnchorOffPage(null), false);
});

const interaction = (overrides: Partial<ReaderInteraction>): ReaderInteraction => ({
  trigger: "word-quick-lookup",
  kind: "word",
  text: "harbour",
  normalizedText: "harbour",
  context: "The harbour master refused to talk.",
  location: "epubcfi(/6/4!/4/2,/1:4,/1:11)",
  anchorRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  source: "foliate",
  format: "epub",
  ...overrides,
});

test("only cards opened on a Foliate page with a range follow the page", () => {
  assert.equal(canFoldWithPage(interaction({})), true);
  assert.equal(canFoldWithPage(interaction({ source: "text", format: "text" })), false);
  assert.equal(canFoldWithPage(interaction({ location: "" })), false);
});

test("the ear counts folded cards and breathes while one is still being written", () => {
  assert.deepEqual(foldedEar([]), { count: 0, writing: false });
  assert.deepEqual(foldedEar([{ id: "a" }, { id: "b", loading: true }]), { count: 0, writing: false });
  assert.deepEqual(foldedEar([{ id: "a", folded: true }, { id: "b", loading: true }]), { count: 1, writing: false });
  assert.deepEqual(foldedEar([{ id: "a", folded: true, loading: true }]), { count: 1, writing: true });
});
