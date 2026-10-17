import type { SidePanel } from "./side-panel";
import type { ReaderPanelState } from "./narrow-panels";

/**
 * The reader's two sides as the 「浮笺」 design sees them (docs/impls/ui-redesign-reader.md):
 * each side shows one view in one mode.
 *
 * - `closed` — nothing; the left side leaves only its 3px spine.
 * - `peek`   — the left card, summoned by resting on the spine; it leaves when the pointer does.
 * - `float`  — a card over the page, opened on purpose; the page does not reflow.
 * - `pinned` — the same card, settled: the page gives it room, which reflows once.
 *
 * The reader's older code speaks in `tocOpen / searchOpen / sidePanel`. Those are
 * derived from this state and written back through `withLegacy`, so the code that
 * reads or sets them, and `narrow-panels.ts` with its tests, keep their meaning.
 */
export type LeftView = "toc" | "search";
export type RightView = Exclude<SidePanel, null>;
export type SideMode = "closed" | "peek" | "float" | "pinned";

export interface Side<V> {
  /** The view the side shows, or showed last — kept while closed so reopening returns to it. */
  view: V;
  mode: SideMode;
}

export interface ReaderSides {
  left: Side<LeftView>;
  right: Side<RightView>;
}

/** Whether a side opens pinned. Remembered per side, from the last time its pin was pressed. */
export interface SidePins {
  left: boolean;
  right: boolean;
}

export const INITIAL_SIDES: ReaderSides = {
  left: { view: "toc", mode: "closed" },
  right: { view: "ai", mode: "closed" },
};

/** The card widths (design §10–11), and the inset that keeps a card off the window edge. */
export const LEFT_CARD_WIDTH = 272;
export const RIGHT_CARD_WIDTH = 380;
export const CARD_INSET = 12;

export function isOpen(side: Side<unknown>): boolean {
  return side.mode !== "closed";
}

/** The three flags the rest of the reader reads. */
export function legacyPanels(sides: ReaderSides): ReaderPanelState {
  const leftOpen = isOpen(sides.left);
  return {
    tocOpen: leftOpen && sides.left.view === "toc",
    searchOpen: leftOpen && sides.left.view === "search",
    sidePanel: isOpen(sides.right) ? sides.right.view : null,
  };
}

/**
 * The mode a side opens in when a button, a menu or a shortcut asks for it.
 * Never `peek`: only resting on the spine makes that. A side already standing
 * keeps its mode, so switching the view on it does not move the page.
 */
export function openingMode(current: SideMode, pinPreferred: boolean): SideMode {
  if (current === "float" || current === "pinned") return current;
  return pinPreferred ? "pinned" : "float";
}

/**
 * A write in the old vocabulary, applied to the sides. Closing a view the side
 * is not showing changes nothing, which is what lets the older code close
 * "the other one" in the same breath as opening one.
 */
export function withLegacy(sides: ReaderSides, patch: Partial<ReaderPanelState>, pins: SidePins): ReaderSides {
  let { left, right } = sides;
  // From the mode the side had before this write, so "close the TOC, open
  // search" in one patch keeps a pinned side pinned.
  const openLeft = (view: LeftView) => ({ view, mode: openingMode(sides.left.mode, pins.left) });
  if (patch.tocOpen !== undefined) {
    if (patch.tocOpen) left = openLeft("toc");
    else if (left.view === "toc" && isOpen(left)) left = { ...left, mode: "closed" };
  }
  if (patch.searchOpen !== undefined) {
    if (patch.searchOpen) left = openLeft("search");
    else if (left.view === "search" && isOpen(left)) left = { ...left, mode: "closed" };
  }
  if (patch.sidePanel !== undefined) {
    right = patch.sidePanel
      ? { view: patch.sidePanel, mode: openingMode(right.mode, pins.right) }
      : isOpen(right) ? { ...right, mode: "closed" } : right;
  }
  if (sameSide(left, sides.left) && sameSide(right, sides.right)) return sides;
  return { left, right };
}

function sameSide<V>(a: Side<V>, b: Side<V>): boolean {
  return a.view === b.view && a.mode === b.mode;
}

/** Resting on the spine shows the table of contents, unless the left side is already standing. */
export function peekLeft(sides: ReaderSides): ReaderSides {
  if (isOpen(sides.left)) return sides;
  return { ...sides, left: { view: "toc", mode: "peek" } };
}

/** The pointer left the spine and the card. Only a peek goes with it. */
export function endPeek(sides: ReaderSides): ReaderSides {
  if (sides.left.mode !== "peek") return sides;
  return { ...sides, left: { ...sides.left, mode: "closed" } };
}

/** The pin button: settle a card that is floating (or peeking), or lift a settled one back to floating. */
export function togglePin(sides: ReaderSides, which: keyof ReaderSides): ReaderSides {
  const side = sides[which];
  if (!isOpen(side)) return sides;
  const mode: SideMode = side.mode === "pinned" ? "float" : "pinned";
  return { ...sides, [which]: { ...side, mode } };
}

/**
 * How much room the page gives a side: the card and its inset when pinned on a
 * wide screen, nothing otherwise. A narrow screen shows every open side as a
 * full-page sheet over the page, so nothing is ever pinned there.
 */
export function slotWidth(side: Side<unknown>, cardWidth: number, narrow: boolean): number {
  if (narrow || side.mode !== "pinned") return 0;
  return cardWidth + CARD_INSET * 2;
}

/** Whether going from one state to the next changes the page's width — the only thing that reflows it. */
export function reflowsBetween(previous: ReaderSides, next: ReaderSides, narrow: boolean): boolean {
  return slotWidth(previous.left, LEFT_CARD_WIDTH, narrow) !== slotWidth(next.left, LEFT_CARD_WIDTH, narrow)
    || slotWidth(previous.right, RIGHT_CARD_WIDTH, narrow) !== slotWidth(next.right, RIGHT_CARD_WIDTH, narrow);
}

/**
 * Having used a card that was only floating, put it away: choosing a chapter
 * from the TOC means "take me there", and the reader wants the page back. A
 * pinned card stays — the reader chose to keep it.
 */
export function dismissFloat(sides: ReaderSides, which: keyof ReaderSides): ReaderSides {
  const side = sides[which];
  if (side.mode !== "float" && side.mode !== "peek") return sides;
  return { ...sides, [which]: { ...side, mode: "closed" } };
}
