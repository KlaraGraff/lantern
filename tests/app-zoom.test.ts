import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APP_ZOOM_STEPS,
  DEFAULT_APP_ZOOM,
  appZoomCommandFor,
  claimZoomShortcuts,
  nextAppZoom,
  parseAppZoom,
  zoomShortcutsClaimed,
} from "../src/services/app-zoom.ts";
import { isReservedReaderBinding } from "../src/components/reader-bindings.ts";

const key = (
  value: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {},
) => ({ key: value, metaKey: false, ctrlKey: false, ...modifiers });

describe("appZoomCommandFor", () => {
  it("reads both faces of the zoom keys", () => {
    assert.equal(appZoomCommandFor(key("=", { metaKey: true })), "in");
    assert.equal(appZoomCommandFor(key("+", { metaKey: true })), "in");
    assert.equal(appZoomCommandFor(key("-", { metaKey: true })), "out");
    assert.equal(appZoomCommandFor(key("_", { metaKey: true })), "out");
    assert.equal(appZoomCommandFor(key("0", { metaKey: true })), "reset");
  });

  it("accepts Control for the platforms that use it", () => {
    assert.equal(appZoomCommandFor(key("=", { ctrlKey: true })), "in");
  });

  it("ignores the same keys with no modifier", () => {
    assert.equal(appZoomCommandFor(key("=")), null);
    assert.equal(appZoomCommandFor(key("0")), null);
  });

  it("leaves Alt combinations alone", () => {
    // ⌥ makes a different shortcut, not a louder version of this one.
    assert.equal(appZoomCommandFor(key("=", { metaKey: true, altKey: true })), null);
  });

  it("ignores keys that are not zoom keys", () => {
    assert.equal(appZoomCommandFor(key("1", { metaKey: true })), null);
    assert.equal(appZoomCommandFor(key("[", { metaKey: true })), null);
  });
});

describe("nextAppZoom", () => {
  it("walks the ladder one stop at a time", () => {
    assert.equal(nextAppZoom(100, "in"), 110);
    assert.equal(nextAppZoom(110, "in"), 125);
    assert.equal(nextAppZoom(100, "out"), 90);
    assert.equal(nextAppZoom(90, "out"), 80);
  });

  it("stops at the ends instead of running off them", () => {
    const max = APP_ZOOM_STEPS[APP_ZOOM_STEPS.length - 1];
    assert.equal(nextAppZoom(max, "in"), max);
    assert.equal(nextAppZoom(APP_ZOOM_STEPS[0], "out"), APP_ZOOM_STEPS[0]);
  });

  it("moves a value that is not on the ladder to the nearest stop past it", () => {
    assert.equal(nextAppZoom(105, "in"), 110);
    assert.equal(nextAppZoom(105, "out"), 100);
  });

  it("resets to 100 from anywhere", () => {
    assert.equal(nextAppZoom(200, "reset"), DEFAULT_APP_ZOOM);
    assert.equal(nextAppZoom(80, "reset"), DEFAULT_APP_ZOOM);
  });
});

describe("parseAppZoom", () => {
  it("reads a stored level back", () => {
    assert.equal(parseAppZoom("125"), 125);
  });

  it("falls back to 100 for anything unusable", () => {
    assert.equal(parseAppZoom(null), DEFAULT_APP_ZOOM);
    assert.equal(parseAppZoom(""), DEFAULT_APP_ZOOM);
    assert.equal(parseAppZoom("wide"), DEFAULT_APP_ZOOM);
  });

  it("clamps rather than discards an out-of-range level", () => {
    // A value from a build with a wider ladder is a preference to honour as
    // far as this build can, not a reason to reset the user to 100%.
    assert.equal(parseAppZoom("400"), APP_ZOOM_STEPS[APP_ZOOM_STEPS.length - 1]);
    assert.equal(parseAppZoom("25"), APP_ZOOM_STEPS[0]);
  });
});

describe("zoom shortcut claims", () => {
  it("is unclaimed until a reader asks for it", () => {
    assert.equal(zoomShortcutsClaimed(), false);
    const release = claimZoomShortcuts();
    assert.equal(zoomShortcutsClaimed(), true);
    release();
    assert.equal(zoomShortcutsClaimed(), false);
  });

  it("survives a remount that mounts before it unmounts", () => {
    const first = claimZoomShortcuts();
    const second = claimZoomShortcuts();
    first();
    assert.equal(zoomShortcutsClaimed(), true, "the new reader still holds it");
    second();
    assert.equal(zoomShortcutsClaimed(), false);
  });

  it("ignores a release that runs twice", () => {
    const release = claimZoomShortcuts();
    release();
    release();
    assert.equal(zoomShortcutsClaimed(), false);
    const other = claimZoomShortcuts();
    assert.equal(zoomShortcutsClaimed(), true, "the count did not go negative");
    other();
  });
});

describe("the zoom keys are off limits to reader bindings", () => {
  it("reserves every combination the zoom rule answers", () => {
    for (const modifier of ["Meta", "Control"]) {
      for (const suffix of ["=", "-", "0", "Shift++", "Shift+_"]) {
        assert.equal(
          isReservedReaderBinding(`key:${modifier}+${suffix}`),
          true,
          `key:${modifier}+${suffix}`,
        );
      }
    }
  });
});
