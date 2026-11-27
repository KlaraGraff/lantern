import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCK_MORPH_FADE_MS,
  DOCK_MORPH_MS,
  dockMorphFrames,
  shouldMorph,
  type MorphRect,
} from "../src/pages/reader/dock-morph.ts";

const card: MorphRect = { left: 420, top: 260, width: 360, height: 236 };
const rightCard: MorphRect = { left: 888, top: 64, width: 380, height: 700 };

test("a docked card on a wide screen moves", () => {
  assert.equal(shouldMorph({ from: card, narrow: false, reducedMotion: false }), true);
});

test("reduced motion opens the right card without the move", () => {
  assert.equal(shouldMorph({ from: card, narrow: false, reducedMotion: true }), false);
});

test("below the breakpoint the right side is a sheet with no card to land on", () => {
  assert.equal(shouldMorph({ from: card, narrow: true, reducedMotion: false }), false);
});

test("a card the reader never saw has nowhere to move from", () => {
  assert.equal(shouldMorph({ from: null, narrow: false, reducedMotion: false }), false);
  assert.equal(shouldMorph({ from: { ...card, width: 0 }, narrow: false, reducedMotion: false }), false);
  assert.equal(shouldMorph({ from: { ...card, height: 0 }, narrow: false, reducedMotion: false }), false);
});

test("the box starts squeezed onto the answer card and ends as the right card", () => {
  const frames = dockMorphFrames(card, rightCard);
  assert.ok(frames);
  const [first, last] = frames;
  const sx = 360 / 380;
  const sy = 236 / 700;
  assert.deepEqual(first, { transform: `translate(-468px, 196px) scale(${sx}, ${sy})` });
  assert.deepEqual(last, { transform: "translate(0px, 0px) scale(1, 1)" });
});

test("the move is transform only, so the compositor can run it", () => {
  const frames = dockMorphFrames(card, rightCard) ?? [];
  for (const frame of frames) assert.deepEqual(Object.keys(frame), ["transform"]);
});

test("a right card with no box on screen gets no move", () => {
  assert.equal(dockMorphFrames(card, { ...rightCard, width: 0 }), null);
  assert.equal(dockMorphFrames(card, { ...rightCard, height: 0 }), null);
});

test("the move keeps to the motion caps: travel 260ms, fades at 140ms", () => {
  assert.equal(DOCK_MORPH_MS, 260);
  assert.ok(DOCK_MORPH_FADE_MS <= 140);
});
