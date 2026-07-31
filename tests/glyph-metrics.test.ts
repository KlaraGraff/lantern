import assert from "node:assert/strict";
import test from "node:test";

import { glyphInset } from "../src/components/glyph-metrics.ts";

const close = (value: number, expected: number) => (
  assert.ok(Math.abs(value - expected) < 1e-9, `${value} !== ${expected}`)
);

test("a marker sits on the glyphs rather than filling the line box", () => {
  // 16px text at line-height 1.8: a 28.8px line around a ~19.2px font box.
  close(glyphInset(28.8, 19.2), 4.8);
  // Tight leading leaves nothing to trim.
  close(glyphInset(19.2, 19.2), 0);
});

test("a marker is never grown past the rect it was given", () => {
  assert.equal(glyphInset(19.2, 28.8), 0);
  assert.equal(glyphInset(0, 19.2), 0);
});

test("unmeasurable text keeps the original rect", () => {
  assert.equal(glyphInset(28.8, null), 0);
  assert.equal(glyphInset(28.8, Number.NaN), 0);
});
