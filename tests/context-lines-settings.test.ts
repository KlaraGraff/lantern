import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_LINES_SETTING_KEY,
  contextLinesEnabled,
} from "../src/components/settings/context-lines.ts";

test("an absent setting reads as enabled — the feature defaults on", () => {
  assert.equal(contextLinesEnabled({}), true);
});

test("an explicit \"false\" is the only thing that reads as disabled", () => {
  assert.equal(contextLinesEnabled({ [CONTEXT_LINES_SETTING_KEY]: "false" }), false);
});

test("an explicit \"true\" reads as enabled, same as absent", () => {
  assert.equal(contextLinesEnabled({ [CONTEXT_LINES_SETTING_KEY]: "true" }), true);
});

test("round trip: writing the string a toggle would write reads back correctly", () => {
  const off = { [CONTEXT_LINES_SETTING_KEY]: "false" };
  const on = { ...off, [CONTEXT_LINES_SETTING_KEY]: "true" };
  assert.equal(contextLinesEnabled(off), false);
  assert.equal(contextLinesEnabled(on), true);
});
