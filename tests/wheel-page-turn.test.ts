import assert from "node:assert/strict";
import test from "node:test";

import {
  createWheelPageTurnHandler,
  type WheelTurnDirection,
} from "../src/components/wheel-page-turn.ts";

interface FakeWheelEventInit {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
}

function wheelEvent(init: FakeWheelEventInit): WheelEvent {
  return {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    deltaMode: init.deltaMode ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    preventDefault() {},
  } as unknown as WheelEvent;
}

function harness(options: { enabled?: () => boolean } = {}) {
  const turns: WheelTurnDirection[] = [];
  let clock = 0;
  const handler = createWheelPageTurnHandler({
    turn: (direction) => turns.push(direction),
    isEnabled: options.enabled,
    now: () => clock,
  });
  return {
    turns,
    send(deltaY: number, advanceMs = 16, init: FakeWheelEventInit = {}) {
      clock += advanceMs;
      handler.handleWheel(wheelEvent({ deltaY, ...init }));
    },
  };
}

test("a long swipe with an inertia tail turns exactly one page", () => {
  const { turns, send } = harness();
  for (const delta of [4, 12, 30, 48, 40, 32, 26, 20, 16, 12, 9, 7, 5, 4, 3, 2, 2, 1, 1, 1]) {
    send(delta, 40);
  }
  assert.deepEqual(turns, ["next"]);
});

test("small jitter below the trigger distance never turns", () => {
  const { turns, send } = harness();
  for (let i = 0; i < 5; i += 1) send(6, 16);
  assert.deepEqual(turns, []);
});

test("two swipes separated by a quiet gap each turn once", () => {
  const { turns, send } = harness();
  for (const delta of [20, 40, 20, 8, 3]) send(delta, 30);
  send(30, 400);
  send(30, 30);
  assert.deepEqual(turns, ["next", "next"]);
});

test("a quick second swipe during the inertia tail re-arms via re-acceleration", () => {
  const { turns, send } = harness();
  for (const delta of [30, 50, 24, 12, 6]) send(delta, 30);
  for (const delta of [40, 50]) send(delta, 30);
  assert.deepEqual(turns, ["next", "next"]);
});

test("direction reversal starts a new gesture in the other direction", () => {
  const { turns, send } = harness();
  for (const delta of [30, 40]) send(delta, 20);
  for (const delta of [-30, -40]) send(delta, 20);
  assert.deepEqual(turns, ["next", "previous"]);
});

test("upward swipes turn to the previous page", () => {
  const { turns, send } = harness();
  for (const delta of [-20, -40]) send(delta, 20);
  assert.deepEqual(turns, ["previous"]);
});

test("dominant horizontal deltas are used and line mode is scaled", () => {
  const { turns, send } = harness();
  send(0, 16, { deltaX: 4, deltaMode: 1 });
  assert.deepEqual(turns, ["next"]);
});

test("ctrl+wheel (pinch zoom) is ignored", () => {
  const { turns, send } = harness();
  send(400, 16, { ctrlKey: true });
  assert.deepEqual(turns, []);
});

test("disabled handler ignores events", () => {
  const { turns, send } = harness({ enabled: () => false });
  send(400, 16);
  assert.deepEqual(turns, []);
});
