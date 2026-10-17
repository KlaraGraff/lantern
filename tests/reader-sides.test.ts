import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_SIDES,
  dismissFloat,
  endPeek,
  legacyPanels,
  openingMode,
  peekLeft,
  reflowsBetween,
  slotWidth,
  togglePin,
  withLegacy,
  type ReaderSides,
} from "../src/pages/reader/reader-sides.ts";
import { ALL_PANELS_CLOSED, narrowPanel } from "../src/pages/reader/narrow-panels.ts";

const NO_PINS = { left: false, right: false };
const PINS = { left: true, right: true };

test("the initial state derives to every panel closed", () => {
  assert.deepEqual(legacyPanels(INITIAL_SIDES), ALL_PANELS_CLOSED);
});

test("opening the TOC floats it, or pins it when the left pin is remembered", () => {
  const floated = withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS);
  assert.deepEqual(floated.left, { view: "toc", mode: "float" });
  assert.deepEqual(legacyPanels(floated), { tocOpen: true, searchOpen: false, sidePanel: null });
  const pinned = withLegacy(INITIAL_SIDES, { tocOpen: true }, PINS);
  assert.equal(pinned.left.mode, "pinned");
});

test("search and the TOC share the left side: one replaces the other in the same mode", () => {
  const pinnedToc: ReaderSides = { ...INITIAL_SIDES, left: { view: "toc", mode: "pinned" } };
  const search = withLegacy(pinnedToc, { searchOpen: true, tocOpen: false }, NO_PINS);
  assert.deepEqual(search.left, { view: "search", mode: "pinned" });
  assert.deepEqual(legacyPanels(search), { tocOpen: false, searchOpen: true, sidePanel: null });
});

test("closing a view the side is not showing changes nothing", () => {
  const toc = withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS);
  assert.equal(withLegacy(toc, { searchOpen: false }, NO_PINS), toc);
  assert.equal(withLegacy(INITIAL_SIDES, { sidePanel: null }, NO_PINS), INITIAL_SIDES);
});

test("the older toggle sequence (open one, close the other) lands on the one opened", () => {
  // toggleTocPanel: setTocOpen(!open) then setSearchOpen(false)
  const search = withLegacy(INITIAL_SIDES, { searchOpen: true }, NO_PINS);
  const toc = withLegacy(withLegacy(search, { tocOpen: true }, NO_PINS), { searchOpen: false }, NO_PINS);
  assert.deepEqual(legacyPanels(toc), { tocOpen: true, searchOpen: false, sidePanel: null });
});

test("the right side switches views without changing mode, and remembers its view when closed", () => {
  const ai = withLegacy(INITIAL_SIDES, { sidePanel: "ai" }, PINS);
  assert.deepEqual(ai.right, { view: "ai", mode: "pinned" });
  const traces = withLegacy(ai, { sidePanel: "traces" }, NO_PINS);
  assert.deepEqual(traces.right, { view: "traces", mode: "pinned" });
  const closed = withLegacy(traces, { sidePanel: null }, NO_PINS);
  assert.deepEqual(closed.right, { view: "traces", mode: "closed" });
  assert.equal(legacyPanels(closed).sidePanel, null);
});

test("the derived flags agree with narrowPanel's single-panel pick", () => {
  const both = withLegacy(withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS), { sidePanel: "ai" }, NO_PINS);
  assert.equal(narrowPanel(legacyPanels(both)), "toc");
  assert.equal(narrowPanel(legacyPanels(withLegacy(both, { tocOpen: false }, NO_PINS))), "ai");
});

test("openingMode never produces a peek and keeps a standing mode", () => {
  assert.equal(openingMode("closed", false), "float");
  assert.equal(openingMode("peek", false), "float");
  assert.equal(openingMode("peek", true), "pinned");
  assert.equal(openingMode("float", true), "float");
  assert.equal(openingMode("pinned", false), "pinned");
});

test("resting on the spine peeks the TOC; leaving ends only a peek", () => {
  const peeking = peekLeft(INITIAL_SIDES);
  assert.deepEqual(peeking.left, { view: "toc", mode: "peek" });
  assert.equal(legacyPanels(peeking).tocOpen, true);
  assert.deepEqual(endPeek(peeking).left, { view: "toc", mode: "closed" });
  const floating = withLegacy(INITIAL_SIDES, { searchOpen: true }, NO_PINS);
  assert.equal(peekLeft(floating), floating);
  assert.equal(endPeek(floating), floating);
});

test("a button press during a peek turns it into a standing card", () => {
  const peeking = peekLeft(INITIAL_SIDES);
  assert.equal(withLegacy(peeking, { tocOpen: true }, NO_PINS).left.mode, "float");
});

test("the pin toggles between floating and pinned, and does nothing to a closed side", () => {
  const floating = withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS);
  const pinned = togglePin(floating, "left");
  assert.equal(pinned.left.mode, "pinned");
  assert.equal(togglePin(pinned, "left").left.mode, "float");
  assert.equal(togglePin(peekLeft(INITIAL_SIDES), "left").left.mode, "pinned");
  assert.equal(togglePin(INITIAL_SIDES, "right"), INITIAL_SIDES);
});

test("only a pinned side on a wide screen takes room from the page", () => {
  assert.equal(slotWidth({ view: "toc", mode: "pinned" }, 272, false), 296);
  assert.equal(slotWidth({ view: "ai", mode: "pinned" }, 380, false), 404);
  assert.equal(slotWidth({ view: "toc", mode: "float" }, 272, false), 0);
  assert.equal(slotWidth({ view: "toc", mode: "peek" }, 272, false), 0);
  assert.equal(slotWidth({ view: "toc", mode: "pinned" }, 272, true), 0);
});

test("peeking, floating and switching views never reflow; pinning and unpinning do", () => {
  const peeking = peekLeft(INITIAL_SIDES);
  assert.equal(reflowsBetween(INITIAL_SIDES, peeking, false), false);
  const floating = withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS);
  assert.equal(reflowsBetween(INITIAL_SIDES, floating, false), false);
  const pinned = togglePin(floating, "left");
  assert.equal(reflowsBetween(floating, pinned, false), true);
  assert.equal(reflowsBetween(pinned, withLegacy(pinned, { searchOpen: true }, NO_PINS), false), false);
  assert.equal(reflowsBetween(pinned, togglePin(pinned, "left"), false), true);
  assert.equal(reflowsBetween(floating, pinned, true), false);
});

test("using a floating or peeking card puts it away; a pinned one stays", () => {
  const floating = withLegacy(INITIAL_SIDES, { tocOpen: true }, NO_PINS);
  assert.equal(dismissFloat(floating, "left").left.mode, "closed");
  assert.equal(dismissFloat(peekLeft(INITIAL_SIDES), "left").left.mode, "closed");
  const pinned = togglePin(floating, "left");
  assert.equal(dismissFloat(pinned, "left"), pinned);
  assert.equal(dismissFloat(INITIAL_SIDES, "left"), INITIAL_SIDES);
});
