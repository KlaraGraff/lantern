import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_FADE_TURNS, CHROME_SHOWN, chromeFade } from "../src/pages/reader/chrome-fade.ts";

test("the bar fades after two page turns", () => {
  const once = chromeFade(CHROME_SHOWN, "turn", false);
  assert.equal(once.faded, false);
  const twice = chromeFade(once, "turn", false);
  assert.equal(twice.turns, CHROME_FADE_TURNS);
  assert.equal(twice.faded, true);
  assert.equal(chromeFade(twice, "turn", false).faded, true);
});

test("waking shows the bar and starts the count again", () => {
  const faded = chromeFade(chromeFade(CHROME_SHOWN, "turn", false), "turn", false);
  const woken = chromeFade(faded, "wake", false);
  assert.deepEqual(woken, CHROME_SHOWN);
  assert.equal(chromeFade(woken, "turn", false).faded, false);
});

test("a turn taken while the bar is held does not count", () => {
  const once = chromeFade(CHROME_SHOWN, "turn", false);
  const held = chromeFade(once, "turn", true);
  assert.deepEqual(held, CHROME_SHOWN);
});

test("an idle wake keeps the same state object", () => {
  assert.equal(chromeFade(CHROME_SHOWN, "wake", false), CHROME_SHOWN);
});
