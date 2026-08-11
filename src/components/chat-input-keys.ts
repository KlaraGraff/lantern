import type { KeyboardEvent } from "react";

/**
 * Whether a keypress in a chat composer means "send".
 *
 * With a mouse and real keys, Enter sends and Shift+Enter breaks the line —
 * the convention every desktop chat app uses. Under a finger the two have to
 * swap: the soft keyboard's return is the *only* way to start a new line
 * (there is no Shift to hold down), so leaving it bound to send means a phone
 * can never write a second line and fires half-written questions off instead.
 * The send button is right next to the box and unmissable, so nothing is lost.
 *
 * ⌘/Ctrl+Enter sends either way, so an iPad with a Magic Keyboard — a coarse
 * pointer with real keys attached — keeps a keyboard path to send.
 *
 * `isComposing` is checked first and for both: the Enter that accepts a
 * Chinese IME candidate is the same `keydown` as the Enter that sends, and
 * without this it swallows the candidate and posts the half-typed pinyin.
 */
export function isSendKey(event: KeyboardEvent, coarsePointer: boolean): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !coarsePointer && !event.shiftKey;
}
