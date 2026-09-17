import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent } from "react";

import { chatSendHintKey, isSendKey } from "../src/components/chat-input-keys.ts";

type KeyOptions = {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** Only the keyboard fields `isSendKey` reads, so the test carries no DOM. */
function press(key: string, options: KeyOptions = {}): KeyboardEvent {
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    nativeEvent: {
      isComposing: options.isComposing ?? false,
      keyCode: options.keyCode ?? 0,
    },
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

test("macOS uses Command+Enter for a new line", () => {
  assert.equal(isSendKey(press("Enter"), false, "macos"), true);
  assert.equal(isSendKey(press("Enter", { metaKey: true }), false, "macos"), false);
  assert.equal(isSendKey(press("Enter", { shiftKey: true }), false, "macos"), false);
});

test("Windows and Linux use Shift+Enter for a new line", () => {
  for (const platform of ["windows", "linux"] as const) {
    assert.equal(isSendKey(press("Enter"), false, platform), true);
    assert.equal(isSendKey(press("Enter", { shiftKey: true }), false, platform), false);
  }
});

test("a hardware keyboard can send on a touch device", () => {
  assert.equal(isSendKey(press("Enter", { metaKey: true }), true, "ios"), true);
  assert.equal(isSendKey(press("Enter", { ctrlKey: true }), true, "android"), true);
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
  assert.equal(isSendKey(press("Enter", { keyCode: 229 }), false, "macos"), false);
});

test("no other key sends", () => {
  for (const key of ["a", "Escape", "Tab", "NumpadEnter"]) {
    assert.equal(isSendKey(press(key), false), false);
    assert.equal(isSendKey(press(key, { metaKey: true }), false), false);
  }
});

test("the hint changes by input type and desktop platform", () => {
  assert.equal(chatSendHintKey(false, "macos"), "ai.sendHintMac");
  assert.equal(chatSendHintKey(false, "windows"), "ai.sendHint");
  assert.equal(chatSendHintKey(false, "linux"), "ai.sendHint");
  assert.equal(chatSendHintKey(true, "ios"), "ai.sendHintTouch");
});
