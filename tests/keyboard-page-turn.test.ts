import assert from "node:assert/strict";
import test from "node:test";

import { createKeyboardPageTurnRepeater } from "../src/components/keyboard-page-turn.ts";

test("a held page-turn key advances steadily without queuing every repeat", () => {
  let clock = 0;
  const turns: string[] = [];
  const repeater = createKeyboardPageTurnRepeater({
    turn: (direction) => turns.push(direction),
    now: () => clock,
  });

  repeater.handle("next", false); // initial keydown
  for (clock = 30; clock < 350; clock += 30) repeater.handle("next", true);
  assert.deepEqual(turns, ["next"]);

  clock = 350;
  repeater.handle("next", true);
  assert.deepEqual(turns, ["next", "next"]);

  for (clock = 380; clock < 700; clock += 30) repeater.handle("next", true);
  clock = 700;
  repeater.handle("next", true);
  assert.deepEqual(turns, ["next", "next", "next"]);
});

test("a fresh key press is immediate even after a held key", () => {
  let clock = 0;
  const turns: string[] = [];
  const repeater = createKeyboardPageTurnRepeater({
    turn: (direction) => turns.push(direction),
    now: () => clock,
  });

  repeater.handle("next", false);
  clock = 100;
  repeater.handle("next", true);
  repeater.handle("previous", false);
  assert.deepEqual(turns, ["next", "previous"]);
});

test("rapid distinct key presses remain ordered instead of being mistaken for repeats", () => {
  let clock = 0;
  const turns: string[] = [];
  const repeater = createKeyboardPageTurnRepeater({
    turn: (direction) => turns.push(direction),
    now: () => clock,
  });

  repeater.handle("next", false);
  clock = 50;
  repeater.handle("next", false);
  clock = 100;
  repeater.handle("next", false);
  assert.deepEqual(turns, ["next", "next", "next"]);
});
