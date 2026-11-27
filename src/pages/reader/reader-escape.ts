import type { ReaderSides } from "./reader-sides.ts";

/**
 * What Esc does on the reader, one level per press (design §12, rule ⑤:
 * 弹层 → 卡 → 滑卡 → 纸): a floating card goes first, then the right card,
 * and on the bare page Esc leaves the book.
 *
 * - `null`: something else owns this Esc — a popover, a menu, a dialog, the
 *   phone's raised chrome. It closes itself; the reader does nothing more.
 * - `"panels"`: below the breakpoint, the full-screen panel that is up.
 * - `"left"` / `"right"`: put that card away.
 * - `"leave"`: back to the shelf — on the second press only (see
 *   `confirmsLeave`); the first one says so.
 *
 * A pinned card is part of the page the reader set up, not a layer over it,
 * so Esc passes it by: it stays where it was put.
 */
export type EscapeStep = "panels" | "left" | "right" | "leave" | null;

export function escapeStep({
  overlayOpen,
  narrow,
  narrowPanelOpen,
  sides,
}: {
  overlayOpen: boolean;
  narrow: boolean;
  narrowPanelOpen: boolean;
  sides: ReaderSides;
}): EscapeStep {
  if (overlayOpen) return null;
  if (narrow) return narrowPanelOpen ? "panels" : "leave";
  if (sides.left.mode === "peek" || sides.left.mode === "float") return "left";
  if (sides.right.mode === "float") return "right";
  return "leave";
}

/**
 * How long after the first Esc on the bare page a second one leaves the book.
 * Matches how long the reader's toast that asks for it stays up.
 */
export const LEAVE_CONFIRM_WINDOW_MS = 3500;

/**
 * Whether this Esc on the bare page leaves the book: only when it follows an
 * earlier one (`armedAt`) inside the window. Closing a card and pressing Esc
 * once more by habit must not throw the reader out of the book.
 */
export function confirmsLeave(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now - armedAt >= 0 && now - armedAt < LEAVE_CONFIRM_WINDOW_MS;
}
