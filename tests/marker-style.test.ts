import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultMarkerStyleConfig,
  effectiveAutomaticMarkerStyle,
  MARKER_STYLE_VERSION,
  parseMarkerStyleConfig,
  serializeMarkerStyleConfig,
} from "../src/components/marker-style.ts";

test("an automatic mark no longer arrives wearing the manual mark's colour", () => {
  const defaults = createDefaultMarkerStyleConfig();
  assert.equal(defaults.automaticFollowsManual, false);
  const automatic = effectiveAutomaticMarkerStyle(defaults);
  assert.notEqual(automatic.color, defaults.manual.color);
  // Shape, not just hue, is what tells the two apart — the manual mark is a
  // plain wash and the automatic one carries an underline. That survives the
  // reader repainting their manual marker in any colour they like.
  assert.equal(defaults.manual.underline, false);
  assert.equal(automatic.underline, true);
});

test("a stored v1 config gives up the follow-manual default it never chose", () => {
  // What every v1 install has on disk: the toggle was on because it shipped on.
  const migrated = parseMarkerStyleConfig(JSON.stringify({
    version: 1,
    wordMatchScope: "forms",
    manual: { color: "#4FAE91", opacity: 32, background: true, underline: true, bold: false, font: "inherit" },
    automaticFollowsManual: true,
    automatic: { color: "#8D7C65", opacity: 18, background: true, underline: true, bold: false, font: "inherit" },
    layoutAffectingMarkers: true,
  }));
  assert.equal(migrated.automaticFollowsManual, false);
  assert.equal(migrated.version, MARKER_STYLE_VERSION);
  // Everything the reader could only have set on purpose is left as it was.
  assert.equal(migrated.manual.color, "#4FAE91");
  assert.equal(migrated.manual.underline, true);
  assert.equal(migrated.wordMatchScope, "forms");
  assert.equal(migrated.layoutAffectingMarkers, true);
  assert.equal(migrated.automatic.opacity, 18);
});

test("a v1 config that turned the toggle off is left alone — that was a decision", () => {
  const migrated = parseMarkerStyleConfig(JSON.stringify({
    version: 1,
    automaticFollowsManual: false,
    automatic: { color: "#5B8FD9", opacity: 55, background: true, underline: false, bold: false, font: "inherit" },
  }));
  assert.equal(migrated.automaticFollowsManual, false);
  assert.equal(migrated.automatic.color, "#5B8FD9");
  assert.equal(migrated.automatic.opacity, 55);
});

test("once migrated, turning the toggle back on is a choice that sticks", () => {
  // The migration must not fire twice, or the setting could never be switched
  // on again: it would be reset on the next read, every read.
  const chosen = { ...createDefaultMarkerStyleConfig(), automaticFollowsManual: true };
  const reloaded = parseMarkerStyleConfig(serializeMarkerStyleConfig(chosen));
  assert.equal(reloaded.automaticFollowsManual, true);
  assert.equal(reloaded.version, MARKER_STYLE_VERSION);
});

test("a config from before the setting existed still parses", () => {
  const migrated = parseMarkerStyleConfig(JSON.stringify({ markMatchingWords: false }));
  assert.equal(migrated.wordMatchScope, "current");
  assert.equal(migrated.automaticFollowsManual, false);
  assert.equal(migrated.version, MARKER_STYLE_VERSION);
});
