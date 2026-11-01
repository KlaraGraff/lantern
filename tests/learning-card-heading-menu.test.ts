import assert from "node:assert/strict";
import test from "node:test";

import { isRedundantHeading } from "../src/components/learning-card/heading.ts";
import { parseCardDesignConfig } from "../src/components/learning-card/config.ts";

// F1: the guard's purpose is to drop a heading the module title already says.
// Wrapped in quotes AND followed by a colon is the shape models actually emit.
test("a quoted heading with trailing punctuation is still a restatement", () => {
  assert.equal(isRedundantHeading("「语境含义」：", "当前语境含义"), true);
  assert.equal(isRedundantHeading("**Context meaning**:", "Context meaning in use"), true);
});

// F2: one action id, one row. `parseModules` already keeps that invariant;
// `parseMenu` did not, so a stored config with a repeated id drew the action
// twice — once enabled, once disabled.
test("a repeated menu action id is parsed once", () => {
  const parsed = parseCardDesignConfig({
    version: 2,
    cards: {},
    selectionMenus: {
      word: [
        { id: "copy", enabled: true },
        { id: "copy", enabled: false },
      ],
    },
  });
  const copies = parsed.selectionMenus.word.filter((item) => item.id === "copy");
  assert.equal(copies.length, 1);
  assert.equal(copies[0].enabled, true, "the first stored row wins, as in parseModules");
});
