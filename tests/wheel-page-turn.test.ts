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
  let clock = 0; // wall clock the handler would read via now()
  let eventClock = 0; // when the browser created the event
  const handler = createWheelPageTurnHandler({
    turn: (direction) => turns.push(direction),
    now: () => clock,
    ...options,
  });
  return {
    turns,
    send(deltaY: number, advanceMs = 16, init: FakeWheelEventInit = {}) {
      clock += advanceMs;
      eventClock += advanceMs;
      handler.handleWheel(wheelEvent({ deltaY, timeStamp: eventClock, ...init }));
    },
    /** Main thread blocked: the wall clock jumps, queued events keep their times. */
    stall(ms: number) {
      clock += ms;
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

test("a main-thread stall does not unlatch the gesture mid-tail", () => {
  const { turns, send, stall } = harness();
  for (const delta of [20, 40]) send(delta, 16);
  stall(300); // rendering the page turn blocks past quietMs
  for (const delta of [36, 30, 24]) send(delta, 16);
  assert.deepEqual(turns, ["next"]);
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
