import assert from "node:assert/strict";
import test from "node:test";

import {
  bindingActionsForMenuAction,
  formatReaderBinding,
  menuShortcut,
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

test("the top row's shortcut follows what that row does for this selection", () => {
  // Both readings run the same card, so a binding on either is the top row's
  // shortcut. Order decides which one gets printed when both are bound.
  assert.deepEqual(bindingActionsForMenuAction("primary", "passage"), ["explain", "lookup"]);
  assert.deepEqual(bindingActionsForMenuAction("primary", "word"), ["lookup", "explain"]);
  assert.deepEqual(bindingActionsForMenuAction("primary", "phrase"), ["lookup", "explain"]);

  const both = [
    { actionId: "lookup", trigger: "key:D" },
    { actionId: "explain", trigger: "key:E" },
  ] as const;
  assert.equal(menuShortcut([...both], "primary", "passage"), "E");
  assert.equal(menuShortcut([...both], "primary", "word"), "D");

  // Only one bound, and it is the other reading: still this row's shortcut.
  const lookupOnly = [{ actionId: "lookup", trigger: "key:D" }] as const;
  assert.equal(menuShortcut([...lookupOnly], "primary", "passage"), "D");
});

test("menu rows name their own action, and unbound rows print nothing", () => {
  assert.deepEqual(bindingActionsForMenuAction("save", "word"), ["collect"]);
  assert.deepEqual(bindingActionsForMenuAction("ask-ai", "word"), ["ask_ai"]);
  assert.deepEqual(bindingActionsForMenuAction("custom_a1b2", "word"), ["custom_a1b2"]);

  const bindings = [{ actionId: "collect", trigger: "key:Meta+Shift+S" }] as const;
  assert.equal(menuShortcut([...bindings], "save", "word"), "Cmd+Shift+S");
  assert.equal(menuShortcut([...bindings], "copy", "word"), null);
  assert.equal(menuShortcut([], "save", "word"), null);
});

test("a gesture binding is not printed as a menu shortcut", () => {
  // Real, but useless advice next to a menu the reader already has open: the
  // gesture is how you skip the menu, not something you can do from inside it.
  const bindings = [
    { actionId: "speak", trigger: "mouse:triple" },
    { actionId: "highlight", trigger: "mouse:2" },
  ] as const;
  assert.equal(menuShortcut([...bindings], "speak", "passage"), null);
  assert.equal(menuShortcut([...bindings], "highlight", "passage"), null);
});

test("the shortcut is printed in the reader's own language", () => {
  const bindings = [{ actionId: "speak", trigger: "key:Alt+Space" }] as const;
  assert.equal(menuShortcut([...bindings], "speak", "word", "en"), "Alt+Space");
  assert.equal(menuShortcut([...bindings], "speak", "word", "zh-CN"), "Option+空格");
});

test("triple-click scope falls back to a sentence for anything unrecognised", () => {
  assert.equal(parseTripleClickScope("paragraph"), "paragraph");
  assert.equal(parseTripleClickScope("sentence"), "sentence");
  assert.equal(parseTripleClickScope(undefined), "sentence");
  assert.equal(parseTripleClickScope("page"), "sentence");
});
