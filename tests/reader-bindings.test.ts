import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReaderBinding,
  parseReaderBindings,
} from "../src/components/reader-bindings.ts";
import { parseTripleClickScope } from "../src/components/reader-interaction.ts";

test("mouse triggers survive a round trip through the stored config", () => {
  const parsed = parseReaderBindings({
    version: 1,
    bindings: [
      { actionId: "lookup", trigger: "mouse:double" },
      { actionId: "speak", trigger: "mouse:triple" },
      { actionId: "translate", trigger: "key:F5" },
    ],
  });
  assert.deepEqual(parsed.bindings.map((binding) => binding.trigger), [
    "mouse:double",
    "mouse:triple",
    "key:F5",
  ]);
});

test("triggers no gesture can produce are dropped rather than stored", () => {
  const parsed = parseReaderBindings({
    version: 1,
    bindings: [
      { actionId: "lookup", trigger: "mouse:quadruple" },
      { actionId: "speak", trigger: "wheel:up" },
      { actionId: "collect", trigger: "mouse:triple" },
    ],
  });
  assert.deepEqual(parsed.bindings, [{ actionId: "collect", trigger: "mouse:triple" }]);
});

test("one gesture cannot drive two actions", () => {
  const parsed = parseReaderBindings({
    version: 1,
    bindings: [
      { actionId: "lookup", trigger: "mouse:triple" },
      { actionId: "speak", trigger: "mouse:triple" },
    ],
  });
  assert.deepEqual(parsed.bindings, [{ actionId: "lookup", trigger: "mouse:triple" }]);
});

test("click gestures read as gestures, not as mouse buttons", () => {
  assert.equal(formatReaderBinding("mouse:triple", "en"), "Triple click");
  assert.equal(formatReaderBinding("mouse:triple", "zh-CN"), "三击");
  // Numbered triggers stay separate: button 3 is the mouse's back button.
  assert.equal(formatReaderBinding("mouse:3", "en"), "Mouse back");
});

test("triple-click scope falls back to a sentence for anything unrecognised", () => {
  assert.equal(parseTripleClickScope("paragraph"), "paragraph");
  assert.equal(parseTripleClickScope("sentence"), "sentence");
  assert.equal(parseTripleClickScope(undefined), "sentence");
  assert.equal(parseTripleClickScope("page"), "sentence");
});
