import assert from "node:assert/strict";
import test from "node:test";

import {
  CASCADE_STEP,
  MIN_VISIBLE,
  cascadeOrigin,
  isOriginOnAnyScreen,
  isOriginVisible,
  restoredOrigin,
  type Point,
  type Rect,
} from "../src/utils/reader-window-placement.ts";

/** A 14" MacBook Pro's work area: menu bar off the top, dock off the bottom.
 *  Chosen on purpose — a 1440×960 reader window does not fit inside it, which
 *  is the case a naive "does the whole window fit" rule gets wrong. */
const LAPTOP: Rect = { x: 0, y: 38, width: 1512, height: 906 };

test("a new window steps down and to the right of the window that opened it", () => {
  const origin = cascadeOrigin({ anchor: { x: 100, y: 100 }, workArea: LAPTOP });
  assert.deepEqual(origin, { x: 100 + CASCADE_STEP, y: 100 + CASCADE_STEP });
});

test("cascades even though the window is taller than the work area", () => {
  // The regression this module exists for: 1440×960 never fits 1512×906, and a
  // fits-or-bust rule sent every window back to the same corner.
  const first = cascadeOrigin({ anchor: { x: 36, y: 44 }, workArea: LAPTOP });
  const second = cascadeOrigin({ anchor: { x: 36, y: 44 }, workArea: LAPTOP, taken: [first] });
  assert.notDeepEqual(first, second);
  assert.ok(isOriginVisible(first, LAPTOP));
  assert.ok(isOriginVisible(second, LAPTOP));
});

test("steps past a window already parked on the landing spot", () => {
  const anchor: Point = { x: 200, y: 200 };
  const taken = [{ x: 200 + CASCADE_STEP, y: 200 + CASCADE_STEP }];
  const origin = cascadeOrigin({ anchor, workArea: LAPTOP, taken });
  assert.deepEqual(origin, { x: 200 + CASCADE_STEP * 2, y: 200 + CASCADE_STEP * 2 });
});

test("opening several books in a row never repeats a position", () => {
  const taken: Point[] = [];
  for (let i = 0; i < 8; i += 1) {
    taken.push(cascadeOrigin({ anchor: { x: 36, y: 44 }, workArea: LAPTOP, taken: [...taken] }));
  }
  const seen = new Set(taken.map((p) => `${p.x},${p.y}`));
  assert.equal(seen.size, taken.length);
  for (const origin of taken) assert.ok(isOriginVisible(origin, LAPTOP), `${origin.x},${origin.y} off screen`);
});

test("a run that walks off the bottom-right restarts from the work area corner", () => {
  const anchor: Point = { x: LAPTOP.width - MIN_VISIBLE, y: LAPTOP.y + LAPTOP.height - MIN_VISIBLE };
  const origin = cascadeOrigin({ anchor, workArea: LAPTOP });
  assert.deepEqual(origin, { x: LAPTOP.x + CASCADE_STEP, y: LAPTOP.y + CASCADE_STEP });
});

test("an anchor on a monitor that is no longer there lands back on screen", () => {
  const origin = cascadeOrigin({ anchor: { x: -4000, y: -2000 }, workArea: LAPTOP });
  assert.ok(isOriginVisible(origin, LAPTOP));
});

test("a work area with no room for a full step still yields a corner inside it", () => {
  const sliver: Rect = { x: 10, y: 10, width: 40, height: 40 };
  const origin = cascadeOrigin({ anchor: { x: 900, y: 900 }, workArea: sliver });
  assert.deepEqual(origin, { x: 10, y: 10 });
});

test("isOriginVisible wants a grabbable corner, not the whole window", () => {
  assert.ok(isOriginVisible({ x: LAPTOP.width - MIN_VISIBLE, y: 100 }, LAPTOP));
  assert.ok(!isOriginVisible({ x: LAPTOP.width - MIN_VISIBLE + 1, y: 100 }, LAPTOP));
  assert.ok(!isOriginVisible({ x: 100, y: LAPTOP.y - 1 }, LAPTOP));
});

test("isOriginOnAnyScreen scales its margin per screen", () => {
  // Same corner, two screens reporting in physical pixels at different scales.
  const retina = { area: { x: 0, y: 0, width: 3024, height: 1812 }, margin: MIN_VISIBLE * 2 };
  const external = { area: { x: 3024, y: 0, width: 1920, height: 1080 }, margin: MIN_VISIBLE };
  assert.ok(isOriginOnAnyScreen({ x: 4000, y: 500 }, [retina, external]));
  assert.ok(!isOriginOnAnyScreen({ x: 9000, y: 500 }, [retina, external]));
  // 160 logical px shy of the retina screen's right edge is 320 physical px.
  assert.ok(isOriginOnAnyScreen({ x: 3024 - 320, y: 500 }, [retina]));
  assert.ok(!isOriginOnAnyScreen({ x: 3024 - 319, y: 500 }, [retina]));
});

test("a remembered position is honoured when nothing is sitting on it", () => {
  const saved: Point = { x: 412, y: 233 };
  assert.deepEqual(restoredOrigin(saved, LAPTOP, [{ x: 900, y: 700 }]), saved);
});

test("a remembered position gives way when another reader window holds it", () => {
  const saved: Point = { x: 412, y: 233 };
  const restored = restoredOrigin(saved, LAPTOP, [saved]);
  assert.deepEqual(restored, { x: saved.x + CASCADE_STEP, y: saved.y + CASCADE_STEP });
});

test("a remembered position from a bigger screen is pulled back into view", () => {
  const restored = restoredOrigin({ x: 3000, y: 1600 }, LAPTOP);
  assert.ok(isOriginVisible(restored, LAPTOP));
});
