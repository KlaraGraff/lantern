import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_LINES_SETTING_KEY,
  contextLinesEnabled,
  contextLinesRowDisabled,
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

test("the row is disabled unless vector retrieval is exactly \"true\"", () => {
  assert.equal(contextLinesRowDisabled({}), true);
  assert.equal(contextLinesRowDisabled({ ai_vector_retrieval: "false" }), true);
  assert.equal(contextLinesRowDisabled({ ai_vector_retrieval: "maybe" }), true);
  assert.equal(contextLinesRowDisabled({ ai_vector_retrieval: "true" }), false);
});

test("the row can be disabled while the setting itself stays enabled underneath", () => {
  // Turning vector retrieval off must not silently flip context lines off —
  // the toggle should come back on the moment vector retrieval does.
  const settings = { ai_vector_retrieval: "false", [CONTEXT_LINES_SETTING_KEY]: "true" };
  assert.equal(contextLinesRowDisabled(settings), true);
  assert.equal(contextLinesEnabled(settings), true);
});
