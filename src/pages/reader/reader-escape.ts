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
 * - `"leave"`: back to the shelf.
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
