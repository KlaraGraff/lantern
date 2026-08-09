import assert from "node:assert/strict";
import test from "node:test";

import {
  FADED_LOOKUP_STRENGTH,
  fadedLookupMarkStyle,
  lookupFadeLevel,
  lookupMarkRender,
  type LookupFade,
} from "../src/components/lookup-fade.ts";
import {
  createDefaultMarkerStyleConfig,
  effectiveAutomaticMarkerStyle,
  markerStyleCss,
} from "../src/components/marker-style.ts";
import type { MarkerVisualStyle } from "../src/components/marker-style.ts";

const FADES: LookupFade[] = ["full", "faded", "gone"];

function styleAt(opacity: number): MarkerVisualStyle {
  return { ...effectiveAutomaticMarkerStyle(createDefaultMarkerStyleConfig()), opacity };
}

test("fade tiers decide what is drawn while the switch is off", () => {
  assert.equal(lookupFadeLevel("full", false), "full");
  assert.equal(lookupFadeLevel("faded", false), "faded");
  // The one thing the frontend owns: `gone` still arrives from the backend, and
  // stopping here is what keeps it off the page.
  assert.equal(lookupFadeLevel("gone", false), null);
});

test("the switch draws every tier at full, `gone` included", () => {
  for (const fade of FADES) {
    assert.equal(lookupFadeLevel(fade, true), "full", `fade=${fade}`);
  }
  const style = styleAt(20);
  for (const fade of FADES) {
    const render = lookupMarkRender(style, fade, true);
    assert.deepEqual(render, { style, underlineOpacity: 1 }, `fade=${fade}`);
  }
});

test("a full mark is exactly what the reader configured, at any opacity", () => {
  for (const opacity of [5, 16, 34, 100]) {
    const style = styleAt(opacity);
    const render = lookupMarkRender(style, "full", false);
    assert.ok(render);
    assert.equal(render.style.opacity, opacity);
    assert.equal(render.underlineOpacity, 1);
    // Same object, so nothing downstream can tell a full lookup mark apart from
    // the automatic style it has always been drawn with.
    assert.equal(render.style, style);
  }
});

test("a faded mark is a share of the reader's own opacity, not a fixed number", () => {
  for (const opacity of [5, 16, 20, 34, 100]) {
    const render = lookupMarkRender(styleAt(opacity), "faded", false);
    assert.ok(render);
    assert.ok(
      Math.abs(render.style.opacity - opacity * FADED_LOOKUP_STRENGTH) < 0.005,
      `opacity=${opacity} gave ${render.style.opacity}`,
    );
    // Always thinner than the full step, and never gone: someone reading at 5%
    // still has something on the page.
    assert.ok(render.style.opacity < opacity);
    assert.ok(render.style.opacity > 0);
    assert.equal(render.underlineOpacity, FADED_LOOKUP_STRENGTH);
  }
  // Rounded to two decimals on the way out, so the numbers are exact.
  assert.equal(lookupMarkRender(styleAt(100), "faded", false)?.style.opacity, 55);
  assert.equal(lookupMarkRender(styleAt(5), "faded", false)?.style.opacity, 2.75);
  assert.equal(lookupMarkRender(styleAt(16), "faded", false)?.style.opacity, 8.8);
});

test("a gone mark draws nothing while the switch is off", () => {
  assert.equal(lookupMarkRender(styleAt(34), "gone", false), null);
});

test("fading changes only how faint the mark is, never its shape", () => {
  const style = styleAt(34);
  const faded = fadedLookupMarkStyle(style);
  assert.equal(faded.color, style.color);
  // A dashed underline already means `familiar` elsewhere in the app, and a
  // lookup mark must never start meaning that.
  assert.equal(faded.underline, style.underline);
  assert.equal(faded.background, style.background);
  assert.equal(faded.bold, style.bold);
  assert.equal(faded.font, style.font);
  assert.notEqual(faded, style);
  assert.equal(style.opacity, 34, "the configured style is not mutated");
});

test("the underline fades with the background rather than staying solid", () => {
  const style = styleAt(34);
  const full = markerStyleCss(style);
  const faded = markerStyleCss(fadedLookupMarkStyle(style), undefined, FADED_LOOKUP_STRENGTH);
  assert.equal(full.textDecoration, faded.textDecoration);
  assert.notEqual(full.backgroundColor, faded.backgroundColor);
  assert.notEqual(full.textDecorationColor, faded.textDecorationColor);
  // Unfaded output is byte-identical to what shipped before the extra argument
  // existed — no eight-digit hex where there used to be six.
  assert.equal(full.textDecorationColor, style.color);
});
