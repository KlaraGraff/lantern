import type { KeyboardEvent } from "react";
import type { PlatformId } from "../services/platform";

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
 * A touch device still needs a hardware-keyboard path, so ⌘/Ctrl+Enter sends
 * there. On a desktop Mac, however, ⌘+Enter is the requested line-break chord;
 * Windows and Linux keep Shift+Enter for that job.
 *
 * `isComposing` is checked first and for both: the Enter that accepts a
 * Chinese IME candidate is the same `keydown` as the Enter that sends, and
 * without this it swallows the candidate and posts the half-typed pinyin.
 */
export function isSendKey(
  event: KeyboardEvent,
  coarsePointer: boolean,
  platformId: PlatformId = "unknown",
): boolean {
  // WebKit may report `isComposing = false` on the Enter that accepts an IME
  // candidate. keyCode 229 is its fallback signal for that same event.
  if (
    event.key !== "Enter"
    || event.nativeEvent.isComposing
    || event.nativeEvent.keyCode === 229
  ) return false;
  if (coarsePointer) return event.metaKey || event.ctrlKey;
  if (platformId === "macos" && event.metaKey) return false;
  return !event.shiftKey;
}

export function chatSendHintKey(
  coarsePointer: boolean,
  platformId: PlatformId,
): "ai.sendHint" | "ai.sendHintMac" | "ai.sendHintTouch" {
  if (coarsePointer) return "ai.sendHintTouch";
  return platformId === "macos" ? "ai.sendHintMac" : "ai.sendHint";
}
