import assert from "node:assert/strict";
import test from "node:test";

import {
  READER_SETTINGS_POPOVER_WIDTH,
  TEXT_CLEARANCE,
  VIEWPORT_MARGIN,
  resolveReaderSettingsPlacement,
  type PlacementRect,
} from "../src/pages/reader/reader-settings-placement.ts";

// The 「Aa」 button as it sits in the reader toolbar: near the right edge, just
// under the top of the window.
const anchor = (viewportWidth: number): PlacementRect => ({
  left: viewportWidth - 120,
  top: 12,
  right: viewportWidth - 84,
  bottom: 48,
});

const rect = (left: number, right: number): PlacementRect => ({ left, top: 80, right, bottom: 700 });

test("a wide window's empty gutter takes the popover off the text", () => {
  // 1440px window, a 700px column centred: 370px of gutter on the right, more
  // than the 320px panel plus its margins need.
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: rect(370, 1070),
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.equal(placement.mode, "gutter");
  // Panel's left edge clears the text by at least the clearance...
  const leftEdge = 1440 - placement.right - READER_SETTINGS_POPOVER_WIDTH;
  assert.ok(leftEdge >= 1070 + TEXT_CLEARANCE, `left edge ${leftEdge} overlaps the column`);
  // ...and it moved only as far as it had to, staying under the button.
  assert.equal(placement.right, 1440 - 1070 - TEXT_CLEARANCE - READER_SETTINGS_POPOVER_WIDTH);
  assert.equal(placement.top, 52);
});

test("an anchored position that already clears the text does not move", () => {
  // Narrow column hugging the left: the shipped position is fine as it is, and
  // sliding the panel further left would only detach it from its button.
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: rect(60, 500),
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  const anchored = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: null,
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.equal(placement.mode, "gutter");
  assert.equal(placement.right, anchored.right);
});

test("a two-page spread leaves no gutter and falls back to the anchored position", () => {
  // Both columns rendered, text running out to 1400 of 1440 — the same
  // arithmetic as every other case, no special case for spreads.
  const spread = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: rect(40, 1400),
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  const anchored = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: null,
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.equal(spread.mode, "anchored");
  assert.deepEqual(spread, anchored);
});

test("unmeasurable text is the fallback, not an error", () => {
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: null,
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.equal(placement.mode, "anchored");
  assert.equal(placement.right, 84);
});

test("a degenerate zero-width measurement is ignored", () => {
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: rect(600, 600),
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.equal(placement.mode, "anchored");
});

test("a narrow window slides the panel right until 8px of left gutter remains", () => {
  // 360px wide: aligning the panel's right edge with the button would put its
  // left edge off-screen, so the clamp pins it instead.
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(360),
    text: rect(24, 336),
    viewportWidth: 360,
    viewportHeight: 800,
  });
  assert.equal(placement.mode, "anchored");
  assert.equal(placement.right, 360 - READER_SETTINGS_POPOVER_WIDTH - VIEWPORT_MARGIN);
  assert.equal(360 - placement.right - READER_SETTINGS_POPOVER_WIDTH, VIEWPORT_MARGIN);
});

test("below the panel's own width it stays pinned to the right margin", () => {
  // Under ~336px the panel's `max-w-[calc(100dvw-16px)]` takes over the width;
  // the offset must not go negative and push it off the right edge.
  const placement = resolveReaderSettingsPlacement({
    anchor: anchor(300),
    text: rect(16, 284),
    viewportWidth: 300,
    viewportHeight: 700,
  });
  assert.equal(placement.right, VIEWPORT_MARGIN);
});

test("the popover never grows past the bottom of the window", () => {
  const short = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: null,
    viewportWidth: 1440,
    viewportHeight: 400,
  });
  assert.equal(short.maxHeight, 400 - short.top - VIEWPORT_MARGIN);

  const tall = resolveReaderSettingsPlacement({
    anchor: anchor(1440),
    text: null,
    viewportWidth: 1440,
    viewportHeight: 2000,
  });
  assert.equal(tall.maxHeight, 760);
});
