import assert from "node:assert/strict";
import test from "node:test";

// `isCoarsePointer` resolves the media query lazily and then caches it, so the
// stub has to be in place before the first call — which is why this lives in a
// file of its own rather than alongside the other reader-binding tests.
let coarse = false;
(globalThis as { window?: unknown }).window = {
  // `matches` is a getter because the query object is created once and cached;
  // a plain field would freeze at whatever `coarse` was on the first call.
  matchMedia: (query: string) => ({
    get matches() { return query === "(pointer: coarse)" && coarse; },
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
};

const { menuShortcutsVisible } = await import("../src/components/reader-bindings.ts");

test("an explicit choice wins over the device, in both directions", () => {
  for (const pointer of [false, true]) {
    coarse = pointer;
    assert.equal(menuShortcutsVisible("true"), true);
    assert.equal(menuShortcutsVisible("false"), false);
  }
});

test("unset means on for a mouse and off for a finger", () => {
  coarse = false;
  assert.equal(menuShortcutsVisible(undefined), true);
  coarse = true;
  // No keys to press and no ⌘ to press them with — the reserved ⌘C on Copy
  // would advertise a chord the device cannot produce.
  assert.equal(menuShortcutsVisible(undefined), false);
});

test("a value nobody wrote falls back to the device default, not to on", () => {
  coarse = true;
  assert.equal(menuShortcutsVisible(""), false);
  assert.equal(menuShortcutsVisible("yes"), false);
});
