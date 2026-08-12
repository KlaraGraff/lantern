import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_PANELS_CLOSED,
  closesOnNavigate,
  narrowPanel,
  panelShellVisible,
} from "../src/pages/reader/narrow-panels.ts";

test("nothing covers the page when nothing is open", () => {
  assert.equal(narrowPanel(ALL_PANELS_CLOSED), null);
});

test("each panel names itself", () => {
  assert.equal(narrowPanel({ ...ALL_PANELS_CLOSED, tocOpen: true }), "toc");
  assert.equal(narrowPanel({ ...ALL_PANELS_CLOSED, searchOpen: true }), "search");
  assert.equal(narrowPanel({ ...ALL_PANELS_CLOSED, sidePanel: "traces" }), "traces");
  assert.equal(narrowPanel({ ...ALL_PANELS_CLOSED, sidePanel: "ai" }), "ai");
});

// The reader's exclusivity effects settle this within a frame, but the frame in
// between still renders. Exactly one panel has to answer for it, or two back
// bars stack and the reader sees the wrong title over the wrong list.
test("only one panel covers the page even if two flags are momentarily set", () => {
  assert.equal(narrowPanel({ tocOpen: true, searchOpen: true, sidePanel: "ai" }), "toc");
  assert.equal(narrowPanel({ tocOpen: false, searchOpen: true, sidePanel: "ai" }), "search");
});

test("navigating closes the panels only where a panel is covering the page", () => {
  assert.equal(closesOnNavigate(true), true);
  assert.equal(closesOnNavigate(false), false);
});

// The tiebreak `narrowPanel` performs is worth nothing if the losing panel
// still paints. Every narrow shell is `absolute inset-0 z-50`, so a loser that
// rendered would sit on top of the winner — later in DOM order — carrying none
// of the back bar the winner is given. This is the pairing of the two halves.
test("on a narrow screen only the panel that won the tiebreak paints", () => {
  const contested = { tocOpen: true, searchOpen: false, sidePanel: "ai" as const };
  const winner = narrowPanel(contested);
  assert.equal(winner, "toc");

  const open: Record<string, boolean> = {
    toc: contested.tocOpen,
    search: contested.searchOpen,
    traces: contested.sidePanel === "traces",
    ai: contested.sidePanel === "ai",
  };
  const painting = (["toc", "search", "traces", "ai"] as const).filter((panel) =>
    panelShellVisible(open[panel], true, winner === panel),
  );
  assert.deepEqual(painting, ["toc"]);
});

// The same two flags on a wide viewport are not a contest at all: the TOC docks
// on the left and the AI panel on the right, and hiding either would be the bug.
test("on a wide screen both docked panels paint, tiebreak or not", () => {
  assert.equal(panelShellVisible(true, false, false), true);
  assert.equal(panelShellVisible(true, false, true), true);
});

test("a closed panel never paints, at any width", () => {
  for (const narrow of [false, true]) {
    for (const covering of [false, true]) {
      assert.equal(panelShellVisible(false, narrow, covering), false);
    }
  }
});
