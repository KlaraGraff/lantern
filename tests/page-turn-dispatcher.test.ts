import assert from "node:assert/strict";
import test from "node:test";

import { createPageTurnDispatcher } from "../src/components/page-turn-dispatcher.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function flushTurns(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("rapid inputs leave at most one page turn pending after the active animation", async () => {
  const calls: string[] = [];
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const dispatcher = createPageTurnDispatcher({
    turn: (direction) => {
      calls.push(direction);
      return pending.shift()?.promise;
    },
  });

  dispatcher.dispatch("next");
  dispatcher.dispatch("next");
  dispatcher.dispatch("next");
  assert.deepEqual(calls, ["next"]);

  first.resolve();
  await flushTurns();
  assert.deepEqual(calls, ["next", "next"]);

  second.resolve();
  await flushTurns();
  assert.deepEqual(calls, ["next", "next"]);
});

test("the latest direction is retained while an animation is active", async () => {
  const calls: string[] = [];
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const dispatcher = createPageTurnDispatcher({
    turn: (direction) => {
      calls.push(direction);
      return pending.shift()?.promise;
    },
  });

  dispatcher.dispatch("next");
  dispatcher.dispatch("next");
  dispatcher.dispatch("previous");
  first.resolve();
  await flushTurns();
  assert.deepEqual(calls, ["next", "previous"]);
  second.resolve();
});

test("cancels a pending turn when its reader is replaced", async () => {
  const calls: string[] = [];
  const active = deferred();
  const dispatcher = createPageTurnDispatcher({
    turn: (direction) => {
      calls.push(direction);
      return active.promise;
    },
  });

  dispatcher.dispatch("next");
  dispatcher.dispatch("previous");
  dispatcher.cancelPending();
  active.resolve();
  await flushTurns();

  assert.deepEqual(calls, ["next"]);
});
