import test from "node:test";
import assert from "node:assert/strict";
import {
  decideFollow,
  isReaderRelocation,
  type SentencePlacement,
} from "../src/pages/reader/read-aloud-follow.ts";

// The two numbers the source feeds in are DOM boundary-point comparisons
// against the paginator's own visible range, so a case is written as the
// geometry it describes rather than as a pair of signs.

/** Entirely past the far edge of the page. */
const below: SentencePlacement = { startVsVisibleEnd: 1, endVsVisibleStart: 1 };
/** Entirely before the near edge of the page. */
const above: SentencePlacement = { startVsVisibleEnd: -1, endVsVisibleStart: -1 };
/**
 * Any sentence with text on the page: wholly inside it, starting on it and
 * running off the far edge, or started on the previous page and finishing on
 * this one. All three reduce to the same pair — that is the whole point of
 * comparing boundaries rather than measuring rects, and why a sentence spanning
 * a page boundary needs no case of its own.
 */
const overlapping: SentencePlacement = { startVsVisibleEnd: -1, endVsVisibleStart: 1 };

test("a sentence below the page turns to it", () => {
  assert.equal(decideFollow(below, false), "turn");
});

test("a sentence above the page turns back to it", () => {
  assert.equal(decideFollow(above, false), "turn");
});

test("a sentence with any text on the page leaves the view alone", () => {
  assert.equal(decideFollow(overlapping, false), "visible");
});

test("a sentence touching the page only at a boundary has nothing on screen", () => {
  // Ends exactly where the page begins: the whole sentence is behind the reader.
  assert.equal(decideFollow({ startVsVisibleEnd: -1, endVsVisibleStart: 0 }, false), "turn");
  // Begins exactly where the page ends: the whole sentence is ahead of them.
  assert.equal(decideFollow({ startVsVisibleEnd: 0, endVsVisibleStart: 1 }, false), "turn");
});

test("a sentence that cannot be placed against the page is not assumed visible", () => {
  // An unloaded section, or a visible range measured in a document since
  // replaced. Assuming "visible" here is what stopped the page turning at all.
  assert.equal(decideFollow(null, false), "turn");
});

test("after the reader turns the page by hand, playback stops dragging it back", () => {
  assert.equal(decideFollow(below, true), "hold");
  assert.equal(decideFollow(above, true), "hold");
  assert.equal(decideFollow(null, true), "hold");
});

test("the hold ends at the chapter boundary rather than stranding the run there", () => {
  // A sentence in a section that is not on screen can never be measured as
  // visible, so holding on one is a hold nothing releases: the voice would read
  // the whole next chapter to a page still showing this one.
  assert.equal(decideFollow("other-chapter", true), "turn");
  assert.equal(decideFollow("other-chapter", false), "turn");
});

test("following resumes the moment playback catches back up to what they are looking at", () => {
  assert.equal(decideFollow(overlapping, true), "visible");
});

test("only the paginator's own relocations count as automatic", () => {
  for (const reason of ["navigation", "selection", "anchor"]) {
    assert.equal(isReaderRelocation(reason), false, reason);
  }
  // A page turn, a swipe snap, a scroll — and the scrolled-flow page turn, which
  // reports no reason at all.
  for (const reason of ["page", "snap", "scroll", null, undefined]) {
    assert.equal(isReaderRelocation(reason), true, String(reason));
  }
});
