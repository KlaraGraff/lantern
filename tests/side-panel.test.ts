import assert from "node:assert/strict";
import test from "node:test";
import { toggleSidePanel } from "../src/pages/reader/side-panel.ts";

test("opening a closed panel opens it", () => {
  assert.equal(toggleSidePanel(null, "traces"), "traces");
  assert.equal(toggleSidePanel(null, "ai"), "ai");
});

test("re-clicking the open panel's own button closes it", () => {
  assert.equal(toggleSidePanel("traces", "traces"), null);
  assert.equal(toggleSidePanel("ai", "ai"), null);
});

test("clicking a different panel's button switches straight over, no manual close-first step", () => {
  assert.equal(toggleSidePanel("traces", "ai"), "ai");
  assert.equal(toggleSidePanel("ai", "traces"), "traces");
});
