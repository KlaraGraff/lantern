import assert from "node:assert/strict";
import test from "node:test";

import {
  bindingActionsForMenuAction,
  bindingFromKeyboardEvent,
  formatReaderBinding,
  isReservedReaderBinding,
  menuShortcut,
  parseReaderBindings,
  readerMenuRows,
  reservedCopyShortcut,
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
  assert.equal(menuShortcut([...bindings], "save", "word", "en", true), "⇧⌘S");
  assert.equal(menuShortcut([...bindings], "copy", "word", "en", true), null);
  assert.equal(menuShortcut([], "save", "word", "en", true), null);
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
  assert.equal(menuShortcut([...bindings], "speak", "word", "en", true), "⌥Space");
  assert.equal(menuShortcut([...bindings], "speak", "word", "zh-CN", true), "⌥空格");
  assert.equal(menuShortcut([...bindings], "speak", "word", "en", false), "Alt+Space");
});

test("modifiers are glyphs on a Mac and words everywhere else", () => {
  // The glyphs are the reason a shortcut fits on a 220px menu row at all:
  // "Ctrl+Shift+ArrowRight" is wider than most of the labels it sits beside.
  assert.equal(formatReaderBinding("key:Meta+Shift+S", "en", true), "⇧⌘S");
  assert.equal(formatReaderBinding("key:Meta+Shift+S", "en", false), "Win+Shift+S");
  assert.equal(formatReaderBinding("key:Control+Alt+Shift+K", "en", true), "⌃⌥⇧K");
  assert.equal(formatReaderBinding("key:Control+Alt+Shift+K", "en", false), "Ctrl+Alt+Shift+K");
});

test("modifiers print in each platform's own order, not the recorded one", () => {
  // `bindingFromKeyboardEvent` records Meta first; macOS prints it last.
  assert.equal(bindingFromKeyboardEvent({
    key: "k", metaKey: true, ctrlKey: false, altKey: true, shiftKey: true,
  } as KeyboardEvent), "key:Meta+Alt+Shift+K");
  assert.equal(formatReaderBinding("key:Meta+Alt+Shift+K", "en", true), "⌥⇧⌘K");
});

test("arrows are glyphs everywhere; Apple-only glyphs stay words elsewhere", () => {
  assert.equal(formatReaderBinding("key:ArrowRight", "en", true), "→");
  assert.equal(formatReaderBinding("key:ArrowRight", "en", false), "→");
  assert.equal(formatReaderBinding("key:Escape", "en", true), "⎋");
  assert.equal(formatReaderBinding("key:Escape", "en", false), "Esc");
  assert.equal(formatReaderBinding("key:Meta+Enter", "en", false), "Win+Enter");
});

test("the copy row falls back to the key the platform already gave it", () => {
  assert.equal(reservedCopyShortcut("en", true), "⌘C");
  assert.equal(reservedCopyShortcut("en", false), "Ctrl+C");
  // And that fallback is a binding nothing else can claim.
  assert.ok(isReservedReaderBinding("key:Meta+C"));
  assert.ok(isReservedReaderBinding("key:Control+C"));
});

test("triple-click scope falls back to a sentence for anything unrecognised", () => {
  assert.equal(parseTripleClickScope("paragraph"), "paragraph");
  assert.equal(parseTripleClickScope("sentence"), "sentence");
  assert.equal(parseTripleClickScope(undefined), "sentence");
  assert.equal(parseTripleClickScope("page"), "sentence");
});

// The reader decides whether to open the selection menu by counting these rows.
// An empty configured order is not the same as an empty menu — translate is
// injected on top of it — so the two questions must not be confused.
test("an empty order still draws a row when translate is injected", () => {
  assert.deepEqual(readerMenuRows([]), []);
  assert.deepEqual(readerMenuRows([], { showTranslate: true }), ["translate"]);
});

test("rows nothing would render for are not counted", () => {
  // Highlight needs somewhere to put the mark.
  assert.deepEqual(readerMenuRows(["highlight"], { canToggleMark: false }), []);
  assert.deepEqual(readerMenuRows(["highlight"], { canToggleMark: true }), ["highlight"]);

  // A custom id with no definition behind it renders nothing.
  assert.deepEqual(readerMenuRows(["custom_gone"]), []);
  assert.deepEqual(
    readerMenuRows(["custom_gone"], { customActionIds: ["custom_gone"] }),
    ["custom_gone"],
  );
});

test("a menu down to its last built-in row still opens", () => {
  assert.deepEqual(readerMenuRows(["speak"]), ["speak"]);
});

test("translate is not injected twice when the order already has it", () => {
  assert.deepEqual(
    readerMenuRows(["primary", "translate"], { showTranslate: true }),
    ["primary", "translate"],
  );
});
