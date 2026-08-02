import assert from "node:assert/strict";
import test from "node:test";

import {
  FONT_SIZE_MIN,
  MEASURE_EM_CAP,
  MEASURE_EM_MIN,
  capMeasureWidth,
  getEffectiveFontSize,
  getReaderMeasure,
  getTextReaderMeasure,
} from "../src/components/reader-settings.ts";

const base = {
  readingMode: "scrolling" as const,
  pageColumns: 1 as const,
  margins: 0,
  fontSize: 26,
  narrowFontShrink: true,
};

test("a column is never wider than the comfortable measure", () => {
  assert.equal(capMeasureWidth(2560, 26), MEASURE_EM_CAP * 26);
  assert.equal(capMeasureWidth(500, 26), 500);
  // Exactly at the cap the available width wins, so no rounding drift.
  assert.equal(capMeasureWidth(MEASURE_EM_CAP * 26, 26), MEASURE_EM_CAP * 26);
});

test("the cap binds on wide viewports and leaves narrow ones alone", () => {
  // 1440 with the AI side panel open: still under the cap at 26px.
  assert.equal(getReaderMeasure(base, 860, 900).columnWidth, 860);
  // 1440 with the panel closed, and a 2560 fullscreen: both capped.
  assert.equal(getReaderMeasure(base, 1440, 900).columnWidth, MEASURE_EM_CAP * 26);
  assert.equal(getReaderMeasure(base, 2560, 1400).columnWidth, MEASURE_EM_CAP * 26);
});

test("margins act as a minimum: the cap can only widen them", () => {
  const width = 2560;
  const withMargins = getReaderMeasure({ ...base, margins: 10 }, width, 1400);
  assert.equal(withMargins.columnWidth, MEASURE_EM_CAP * 26);
  // The surplus the grid's 1fr tracks absorb, split evenly on both sides.
  const margin = (width - withMargins.columnWidth) / 2;
  assert.ok(margin > (width * 0.1) / 2);
});

test("two columns each get the cap, not the pair", () => {
  const settings = { ...base, readingMode: "paginated" as const, pageColumns: 2 as const };
  const measure = getReaderMeasure(settings, 2560, 1400);
  assert.equal(measure.columns, 2);
  assert.equal(measure.columnWidth, MEASURE_EM_CAP * 26);
  // Portrait falls back to one column, and the cap still applies.
  assert.equal(getReaderMeasure(settings, 900, 1400).columns, 1);
});

test("a narrow viewport shrinks the rendered size", () => {
  assert.equal(getReaderMeasure(base, 390, 800).fontSize, Math.floor(390 / MEASURE_EM_MIN));
  // Once shrunk the column is the full width again — there is nothing to cap.
  assert.equal(getReaderMeasure(base, 390, 800).columnWidth, 390);
});

test("the narrow-viewport rule only ever shrinks", () => {
  for (let fontSize = FONT_SIZE_MIN; fontSize <= 48; fontSize += 1) {
    for (let width = 1; width <= 3000; width += 7) {
      const size = getEffectiveFontSize({ fontSize, narrowFontShrink: true }, width);
      assert.ok(size <= fontSize, `${size} > ${fontSize} at width ${width}`);
      assert.ok(size >= FONT_SIZE_MIN, `${size} below the floor at width ${width}`);
    }
  }
});

test("a wide viewport leaves the user's size untouched", () => {
  assert.equal(getEffectiveFontSize({ fontSize: 26, narrowFontShrink: true }, 1440), 26);
  assert.equal(getReaderMeasure(base, 2560, 1400).fontSize, 26);
});

test("turning the shrink off restores the stored size exactly", () => {
  const off = { ...base, narrowFontShrink: false };
  assert.equal(getReaderMeasure(off, 390, 800).fontSize, 26);
  assert.equal(getEffectiveFontSize({ fontSize: 26, narrowFontShrink: false }, 1), 26);
});

test("the plain-text reader caps the same way and stays centred", () => {
  const wide = getTextReaderMeasure(base, 2560, 1);
  assert.equal(wide.columnWidth, MEASURE_EM_CAP * 26);
  // Column plus its two gutters exactly fills the page slot, so paginated
  // spreads keep scrolling one viewport per page turn.
  assert.equal(wide.columnWidth + wide.padding * 2, 2560);

  const spread = getTextReaderMeasure(base, 2560, 2);
  assert.equal(spread.columnWidth, MEASURE_EM_CAP * 26);
  assert.equal(spread.columnWidth + spread.padding * 2, 1280);
});

test("the plain-text reader keeps its minimum gutter and shrinks when narrow", () => {
  const narrow = getTextReaderMeasure(base, 390, 1);
  assert.equal(narrow.padding, 12);
  assert.equal(narrow.fontSize, Math.floor((390 - 24) / MEASURE_EM_MIN));
  assert.equal(narrow.columnWidth, 390 - 24);
});
