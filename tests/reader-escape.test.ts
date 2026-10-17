import test from "node:test";
import assert from "node:assert/strict";
import { escapeStep } from "../src/pages/reader/reader-escape.ts";
import { INITIAL_SIDES, type ReaderSides } from "../src/pages/reader/reader-sides.ts";

const wide = { overlayOpen: false, narrow: false, narrowPanelOpen: false };
const sides = (left: ReaderSides["left"]["mode"], right: ReaderSides["right"]["mode"]): ReaderSides => ({
  left: { view: "toc", mode: left },
  right: { view: "ai", mode: right },
});

test("an open popover, menu or dialog keeps its Esc", () => {
  assert.equal(escapeStep({ ...wide, overlayOpen: true, sides: sides("float", "float") }), null);
});

test("one level per press: floating left card, then the right card, then the shelf", () => {
  assert.equal(escapeStep({ ...wide, sides: sides("float", "float") }), "left");
  assert.equal(escapeStep({ ...wide, sides: sides("peek", "closed") }), "left");
  assert.equal(escapeStep({ ...wide, sides: sides("closed", "float") }), "right");
  assert.equal(escapeStep({ ...wide, sides: INITIAL_SIDES }), "leave");
});

test("pinned cards are part of the page: Esc passes them by", () => {
  assert.equal(escapeStep({ ...wide, sides: sides("pinned", "pinned") }), "leave");
  assert.equal(escapeStep({ ...wide, sides: sides("pinned", "float") }), "right");
});

test("on a phone, Esc closes the full-screen panel before it leaves", () => {
  const narrow = { overlayOpen: false, narrow: true, sides: sides("float", "closed") };
  assert.equal(escapeStep({ ...narrow, narrowPanelOpen: true }), "panels");
  assert.equal(escapeStep({ ...narrow, narrowPanelOpen: false }), "leave");
});
