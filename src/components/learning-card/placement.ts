import type { SerializableRect } from "../reader-interaction";

/**
 * Where a learning card opens, as data.
 *
 * Split out of `LearningCardController` so the geometry can be tested without a
 * React tree or a DOM: it is arithmetic on four rectangles and nothing else.
 */

export interface CardPoint {
  left: number;
  top: number;
}

export interface CardPlacement extends CardPoint {
  maxHeight: number;
}

/** Clearance the card keeps from the reader's edges and from the text column. */
export const CARD_MARGIN = 12;

// Cards already open keep their place, so each new one is nudged down-right to
// leave the earlier headers reachable when two words sit on the same line.
export const STACK_STEP = 22;
export const STACK_STEP_LIMIT = 3;

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function boundsOrWindow(rect: SerializableRect | DOMRect | null | undefined): Bounds {
  if (rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * The card's left edge when it can stand in a blank margin instead of over the
 * page, or `null` when neither margin is wide enough to hold it whole.
 *
 * The reader's column is capped at a comfortable line length, so on a wide
 * window the surplus width ends up as blank strips either side of the text —
 * often several hundred pixels each. A card parked in one of those covers
 * nothing the reader is trying to read, which beats any amount of care about
 * where near the word it lands.
 *
 * Right first, then left. Not because right is better — the reader asked for
 * "whichever side does not cover the text" — but because the choice has to be
 * *stable*: picking the side nearer the clicked word would flip the card across
 * the page depending on where in a line the word happens to fall. Right is
 * where these have always opened, so preferring it keeps the common case
 * unchanged and uses the left strip exactly when the right one has been eaten
 * by an open side panel.
 */
export function marginDock(
  reader: Bounds,
  textRect: SerializableRect | DOMRect | null | undefined,
  width: number,
  margin = CARD_MARGIN,
): number | null {
  if (!textRect) return null;
  // Hug the text rather than the window edge: the card stays associated with
  // the word, and the outer end of the strip is the part nobody looks at.
  const needed = width + margin * 2;
  if (reader.right - textRect.right >= needed) return textRect.right + margin;
  if (textRect.left - reader.left >= needed) return textRect.left - margin - width;
  return null;
}

/**
 * Where a card opens for one interaction.
 *
 * `textRect` is the page area in viewport coordinates — the band the text is
 * laid out in. Omitted (PDF, fixed-layout, the plain-text reader) the card
 * falls back to opening beside the word, which is what it always did.
 */
export function cardPosition(
  interaction: { anchorRect: SerializableRect },
  readerRect: SerializableRect | DOMRect | null | undefined,
  width: number,
  stackIndex = 0,
  textRect?: SerializableRect | DOMRect | null,
): CardPlacement {
  const reader = boundsOrWindow(readerRect);
  const margin = CARD_MARGIN;
  const availableHeight = Math.max(0, reader.height - margin * 2);
  const maxHeight = Math.min(window.innerHeight * 0.75, availableHeight);

  const docked = marginDock(reader, textRect, width, margin);
  const preferredRight = interaction.anchorRect.right + 8;
  const preferredLeft = interaction.anchorRect.left - width - 8;
  const left = docked ?? (
    preferredRight + width <= reader.right - margin
      ? preferredRight
      : preferredLeft >= reader.left + margin
        ? preferredLeft
        : Math.max(reader.left + margin, Math.min(
            interaction.anchorRect.left,
            reader.right - width - margin,
          ))
  );

  const below = reader.bottom - interaction.anchorRect.bottom - margin;
  const above = interaction.anchorRect.top - reader.top - margin;
  const top = below >= Math.min(360, maxHeight) || below >= above
    ? Math.min(interaction.anchorRect.bottom + 8, reader.bottom - maxHeight - margin)
    : Math.max(reader.top + margin, interaction.anchorRect.top - maxHeight - 8);

  const cascade = Math.min(stackIndex, STACK_STEP_LIMIT) * STACK_STEP;
  return {
    // A docked card cascades downward only. Stepping it sideways too would walk
    // the stack straight back onto the text the dock exists to keep clear.
    left: docked === null ? left + cascade : left,
    top: Math.max(reader.top + margin, top) + cascade,
    maxHeight,
  };
}

export function clampCardPoint(
  point: CardPoint,
  readerRect: SerializableRect | DOMRect | null | undefined,
  cardWidth: number,
  cardHeight: number,
): CardPoint {
  const reader = boundsOrWindow(readerRect);
  const margin = CARD_MARGIN;
  const minLeft = reader.left + margin;
  const minTop = reader.top + margin;
  const maxLeft = Math.max(minLeft, reader.right - cardWidth - margin);
  const maxTop = Math.max(minTop, reader.bottom - cardHeight - margin);
  return {
    left: Math.min(maxLeft, Math.max(minLeft, point.left)),
    top: Math.min(maxTop, Math.max(minTop, point.top)),
  };
}
