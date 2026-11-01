import assert from "node:assert/strict";
import test from "node:test";

import {
  bindingFromKeyboardEvent,
  formatReaderBinding,
  menuShortcut,
} from "../src/components/reader-bindings.ts";
import { chatRounds, isMultiRoundChat } from "../src/components/qa/types.ts";
import { readingAssistanceSettingsChanged } from "../src/components/reading-assistance-events.ts";

const key = (value: string, mods: Partial<KeyboardEvent> = {}) =>
  bindingFromKeyboardEvent({
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent);

// `+` is both the separator and a key. Splitting the recorded trigger on "+"
// and taking the last piece therefore yields an empty key: the row reads
// "Shift+" — a modifier the reader can press, followed by nothing.
test("formats a binding on the \"+\" key with the key still on the row", () => {
  const recorded = key("+", { shiftKey: true });
  assert.equal(recorded, "key:Shift++");
  assert.equal(formatReaderBinding(recorded, "en", false), "Shift++");
  assert.equal(formatReaderBinding(recorded, "zh-CN", true), "⇧+");
  // Zoom is bound to this exact chord, so the same rule has to hold for the
  // reserved triggers too, and for a bare unmodified "+".
  assert.equal(formatReaderBinding("key:Meta+Shift++", "en", false), "Win+Shift++");
  assert.equal(formatReaderBinding("key:+", "en", false), "+");
});

test("a menu row prints the \"+\" binding it is driven by, not a dangling modifier", () => {
  const printed = menuShortcut(
    [{ actionId: "lookup", trigger: "key:Shift++" }],
    "primary",
    "word",
    "en",
    false,
  );
  assert.equal(printed, "Shift++");
});

// 「继续问了 N 轮」 counts the rounds asked *after* the first one — that is
// what makes it a multi-round thread, and why it only appears once a second
// question exists. Counting every message pair instead counts the first
// question as a round of its own and is one too high from then on.
test("a thread with one follow-up says one round, not two", () => {
  const thread = (messageCount: number) => ({ message_count: messageCount }) as never;
  assert.equal(isMultiRoundChat(thread(2)), false);
  assert.equal(isMultiRoundChat(thread(3)), true);
  assert.equal(chatRounds(thread(3)), 1);
  assert.equal(chatRounds(thread(4)), 1);
  assert.equal(chatRounds(thread(5)), 2);
  assert.equal(chatRounds(thread(7)), 3);
});

// The reader reconciles settings on window focus by diffing the store against
// the snapshot it last applied. That diff is driven by
// READING_ASSISTANCE_SETTING_KEYS, so a key the reader actually reads but the
// list omits is a key whose change in another window is silently ignored when
// the reader comes back into focus (the event was missed, which is exactly
// what the focus path is for).
test("every reader setting the focus-time diff guards is in its key list", () => {
  const before = { reader_bindings: "a", show_menu_shortcuts: "true" };
  const after = { reader_bindings: "b", show_menu_shortcuts: "false" };
  assert.equal(readingAssistanceSettingsChanged(after, before), true);
  assert.equal(
    readingAssistanceSettingsChanged({ reader_bindings: "b" }, { reader_bindings: "a" }),
    true,
  );
  assert.equal(
    readingAssistanceSettingsChanged({ ...before, show_menu_shortcuts: "false" }, before),
    true,
  );
});
