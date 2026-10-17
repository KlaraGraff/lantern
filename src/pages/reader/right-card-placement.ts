import { CARD_INSET, RIGHT_CARD_WIDTH } from "./reader-sides.ts";

/** What the page keeps on its left when the text steps aside (design §11). */
export const MIN_KEPT_MARGIN = 96;

export type RightCardPlacement =
  | { mode: "float"; shift: number }
  | { mode: "pinned" };

/**
 * Where the right card may float without covering a word (design §11: 「几何不
 * 允许浮就坐下，永不盖字」).
 *
 * The card takes the right `RIGHT_CARD_WIDTH + 2 × CARD_INSET` of the page. If
 * the right margin already has that room, the card floats over it. If the
 * text can step left far enough — by translating, which does not reflow —
 * while keeping `MIN_KEPT_MARGIN` on its left, it floats and the page shifts.
 * Otherwise the card sits down: it opens pinned and the page gives it room.
 *
 * `textLeft` and `textRight` are the rendered text's edges, measured from the
 * page viewport's left edge. Without a measurement the card opens pinned,
 * which can never cover text.
 */
export function placeRightCard(
  viewportWidth: number,
  text: { left: number; right: number } | null,
  cardWidth: number = RIGHT_CARD_WIDTH,
): RightCardPlacement {
  if (!text || !(viewportWidth > 0) || text.right <= text.left) return { mode: "pinned" };
  const slot = cardWidth + CARD_INSET * 2;
  const rightMargin = viewportWidth - text.right;
  if (rightMargin >= slot) return { mode: "float", shift: 0 };
  const shift = Math.ceil(slot - rightMargin);
  if (shift <= text.left - MIN_KEPT_MARGIN) return { mode: "float", shift };
  return { mode: "pinned" };
}
