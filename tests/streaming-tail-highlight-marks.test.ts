import assert from "node:assert/strict";
import test from "node:test";

import { settleStreamingTail } from "../src/components/ai-markdown/streaming-tail.ts";

// The streaming tail guard must never invent a closing marker that the answer
// did not open. Two shapes broke that promise: a literal `===` run (a JS
// comparison, which the remark layer deliberately treats as plain text), and a
// marker sitting inside an inline code span, which markdown renders literally.

test("streaming tail: a literal === run never grows a closing ==", () => {
  assert.equal(settleStreamingTail("In JS, a === b"), "In JS, a === b");
  assert.equal(settleStreamingTail("==="), "===");
});

test("streaming tail: a marker inside an inline code span is not counted", () => {
  assert.equal(settleStreamingTail("Compare `a == b` here."), "Compare `a == b` here.");
  assert.equal(settleStreamingTail("Use `**kwargs` here."), "Use `**kwargs` here.");
});

// The behaviour that must survive the fix.
test("streaming tail: real half-arrived markers still settle", () => {
  assert.equal(settleStreamingTail("The key form =="), "The key form ");
  assert.equal(settleStreamingTail("The ==present per"), "The ==present per==");
  assert.equal(settleStreamingTail("A **bo"), "A **bo**");
  assert.equal(settleStreamingTail("A ~~stri"), "A ~~stri~~");
  assert.equal(settleStreamingTail("Compare `take u"), "Compare `take u`");
  assert.equal(settleStreamingTail("A ==closed mark== stays."), "A ==closed mark== stays.");
});
