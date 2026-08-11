import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent } from "react";

import { isSendKey } from "../src/components/chat-input-keys.ts";

type KeyOptions = {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
};

/** Only the four fields `isSendKey` reads, so the test carries no DOM. */
function press(key: string, options: KeyOptions = {}): KeyboardEvent {
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    nativeEvent: { isComposing: options.isComposing ?? false },
  } as unknown as KeyboardEvent;
}

test("with a mouse and keys, Enter sends and Shift+Enter breaks the line", () => {
  assert.equal(isSendKey(press("Enter"), false), true);
  assert.equal(isSendKey(press("Enter", { shiftKey: true }), false), false);
});

test("under a finger, return breaks the line instead of sending", () => {
  // The soft keyboard has no Shift to hold, so if return sent there would be
  // no way to write a second line at all.
  assert.equal(isSendKey(press("Enter"), true), false);
  assert.equal(isSendKey(press("Enter", { shiftKey: true }), true), false);
});

test("⌘/Ctrl+Enter sends whatever the pointer is", () => {
  for (const coarse of [false, true]) {
    assert.equal(isSendKey(press("Enter", { metaKey: true }), coarse), true);
    assert.equal(isSendKey(press("Enter", { ctrlKey: true }), coarse), true);
  }
});

test("the Enter that accepts an IME candidate never sends", () => {
  // Same keydown as a real send on a Chinese keyboard — without the guard it
  // swallows the candidate and posts the half-typed pinyin.
  for (const coarse of [false, true]) {
    assert.equal(isSendKey(press("Enter", { isComposing: true }), coarse), false);
    assert.equal(
      isSendKey(press("Enter", { isComposing: true, metaKey: true }), coarse),
      false,
    );
  }
});

test("no other key sends", () => {
  for (const key of ["a", "Escape", "Tab", "NumpadEnter"]) {
    assert.equal(isSendKey(press(key), false), false);
    assert.equal(isSendKey(press(key, { metaKey: true }), false), false);
  }
});
