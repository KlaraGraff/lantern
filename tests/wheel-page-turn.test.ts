import assert from "node:assert/strict";
import test from "node:test";

import {
  createWheelPageTurnHandler,
  type WheelPageTurnOptions,
  type WheelTurnDirection,
} from "../src/components/wheel-page-turn.ts";

interface FakeWheelEventInit {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  timeStamp?: number;
}

function wheelEvent(init: FakeWheelEventInit): WheelEvent {
  return {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    deltaMode: init.deltaMode ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    timeStamp: init.timeStamp,
    preventDefault() {},
  } as unknown as WheelEvent;
}

function harness(options: Partial<WheelPageTurnOptions> = {}) {
  const turns: WheelTurnDirection[] = [];
  let clock = 0;
  const handler = createWheelPageTurnHandler({
    turn: (direction) => turns.push(direction),
    now: () => clock,
    ...options,
  });
  return {
    turns,
    send(deltaY: number, advanceMs = 16, init: FakeWheelEventInit = {}) {
      clock += advanceMs;
      handler.handleWheel(wheelEvent({ deltaY, ...init }));
    },
  };
}

test("a flick with a long, slowly decaying momentum tail turns exactly one page", () => {
  const { turns, send } = harness();
  for (const delta of [8, 18, 30, 38, 42]) send(delta, 16); // finger
  // The tail that made the decay-test build flip three or four pages.
  for (let delta = 40; delta >= 2; delta -= 2) send(delta, 16);
  assert.deepEqual(turns, ["next"]);
});

test("a sustained drag turns exactly one page", () => {
  // Regression: the previous handler turned a page per cooldown window here.
  const { turns, send } = harness();
  for (let i = 0; i < 60; i += 1) send(i % 2 === 0 ? 28 : 32, 20); // 1.2s
  assert.deepEqual(turns, ["next"]);
});

test("jitter below the trigger distance never turns", () => {
  const { turns, send } = harness();
  for (let i = 0; i < 4; i += 1) send(6, 16);
  assert.deepEqual(turns, []);
});

test("two flicks separated by real silence each turn once", () => {
  const { turns, send } = harness();
  for (const delta of [20, 40, 20, 8, 3]) send(delta, 16);
  send(20, 400);
  send(40, 16);
  assert.deepEqual(turns, ["next", "next"]);
});

test("a second flick during the momentum tail is swallowed", () => {
  // The accepted cost of the hard latch: without a phase flag a fresh push and
  // the tail it lands in are indistinguishable, so the re-flick waits.
  const { turns, send } = harness();
  for (const delta of [20, 40, 30, 26, 20, 15]) send(delta, 16);
  for (const delta of [45, 60, 55]) send(delta, 16);
  assert.deepEqual(turns, ["next"]);
});

test("event.timeStamp is ignored, so two documents cannot fake a quiet gap", () => {
  // Regression: the handler is fed by listeners on the reader viewport and on
  // foliate's iframe, whose time origins differ by however long the app had
  // been running. Reading event.timeStamp compared those two zero points and
  // scored the difference as silence, unlatching mid-tail.
  const { turns, send } = harness();
  for (const delta of [20, 40]) send(delta, 16); // turns
  // Same steady 16ms stream, but timestamps jumping as if from another realm.
  send(36, 16, { timeStamp: 900_000 });
  send(30, 16, { timeStamp: 12 });
  send(24, 16, { timeStamp: 900_016 });
  assert.deepEqual(turns, ["next"]);
});

test("a misread gap costs one page, not a cascade", () => {
  // Even if something fakes silence on every single event, the floor between
  // turns bounds the result — this is what stops three or four pages per flick.
  const { turns, send } = harness({ quietMs: 0, minTurnGapMs: 350 });
  for (let i = 0; i < 40; i += 1) send(60, 16); // 640ms, every event "idle"
  assert.equal(turns.length, 2); // one at t=16, one past the 350ms floor
});

test("the floor does not delay a genuine flick after the tail dies", () => {
  const { turns, send } = harness();
  for (const delta of [20, 40]) send(delta, 16);
  for (let delta = 38; delta >= 2; delta -= 2) send(delta, 16); // ~300ms tail
  send(20, 200); // silence, and past the floor
  send(40, 16);
  assert.deepEqual(turns, ["next", "next"]);
});

test("upward flicks turn to the previous page", () => {
  const { turns, send } = harness();
  for (const delta of [-20, -40]) send(delta, 16);
  assert.deepEqual(turns, ["previous"]);
});

test("a reversal after silence turns the other way", () => {
  const { turns, send } = harness();
  for (const delta of [20, 40]) send(delta, 16);
  send(-20, 400);
  send(-40, 16);
  assert.deepEqual(turns, ["next", "previous"]);
});

test("a sign flip before the trigger distance retargets the same gesture", () => {
  const { turns, send } = harness();
  send(30, 16);
  for (const delta of [-30, -30]) send(delta, 16);
  assert.deepEqual(turns, ["previous"]);
});

test("reset drops the latch so the next event starts a fresh gesture", () => {
  const turns: WheelTurnDirection[] = [];
  let clock = 0;
  const handler = createWheelPageTurnHandler({
    turn: (direction) => turns.push(direction),
    now: () => clock,
  });
  const send = (deltaY: number) => {
    clock += 16;
    handler.handleWheel(wheelEvent({ deltaY, timeStamp: clock }));
  };
  send(60);
  send(60);
  assert.deepEqual(turns, ["next"]);
  handler.reset();
  send(60);
  assert.deepEqual(turns, ["next", "next"]);
});

test("dominant horizontal deltas are used and line mode is scaled", () => {
  const { turns, send } = harness();
  send(0, 16, { deltaX: 4, deltaMode: 1 }); // 4 lines * 16px
  assert.deepEqual(turns, ["next"]);
});

test("ctrl+wheel (pinch zoom) is ignored", () => {
  const { turns, send } = harness();
  send(400, 16, { ctrlKey: true });
  assert.deepEqual(turns, []);
});

test("disabled handler ignores events", () => {
  const { turns, send } = harness({ isEnabled: () => false });
  send(400, 16);
  assert.deepEqual(turns, []);
});
