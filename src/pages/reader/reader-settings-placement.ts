// Where the reader's 「Aa」 settings popover lands.
//
// The popover used to be anchored under the button unconditionally, which on a
// desktop window in single-page mode clipped the right edge of the reading
// column — the user was adjusting typography while the panel covered the very
// text they were judging. There is usually an empty gutter beside the column
// wide enough to hold the panel, so the placement now measures first and
// decides second.
//
// Two halves, deliberately split: `measureRenderedTextRect` reads live DOM
// geometry (impure, untestable without a browser) and
// `resolveReaderSettingsPlacement` turns rects into a position (pure, and where
// every rule actually lives). The unit tests exercise the second one.

/** A rect reduced to what the placement needs; `DOMRect` satisfies it. */
export interface PlacementRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Mirrors the `w-[320px]` on the panel itself. */
export const READER_SETTINGS_POPOVER_WIDTH = 320;
/** Gutter kept between the popover and the window edge, on both sides. */
export const VIEWPORT_MARGIN = 8;
/** Clear space kept between the rendered text and the popover's left edge. */
export const TEXT_CLEARANCE = 16;
/** Tallest the popover ever grows, matching the shipped panel. */
export const POPOVER_MAX_HEIGHT = 760;
/** Distance from the toolbar button's bottom edge to the popover's top. */
const ANCHOR_GAP = 4;

export interface ReaderSettingsPlacement {
  top: number;
  /** Distance from the window's right edge, as the panel is right-positioned. */
  right: number;
  maxHeight: number;
  /**
   * `gutter` when the empty space beside the text column could hold the panel,
   * `anchored` when it fell back to sitting directly under the 「Aa」 button.
   */
  mode: "gutter" | "anchored";
}

export interface ReaderSettingsPlacementInput {
  /** The 「Aa」 toolbar button. */
  anchor: PlacementRect;
  /** The rendered text column, or null when it could not be measured. */
  text: PlacementRect | null;
  viewportWidth: number;
  viewportHeight: number;
  popoverWidth?: number;
}

/**
 * Decide once, when the popover opens. Font size, margins and line height all
 * change the column width, so recomputing this live would make the panel jump
 * around under the user's hand while they drag a slider — worse than the
 * overlap it is meant to fix.
 */
export function resolveReaderSettingsPlacement({
  anchor,
  text,
  viewportWidth,
  viewportHeight,
  popoverWidth = READER_SETTINGS_POPOVER_WIDTH,
}: ReaderSettingsPlacementInput): ReaderSettingsPlacement {
  const top = Math.max(VIEWPORT_MARGIN, anchor.bottom + ANCHOR_GAP);
  const maxHeight = Math.max(0, Math.min(POPOVER_MAX_HEIGHT, viewportHeight - top - VIEWPORT_MARGIN));
  // The shipped anchored position: right edge aligned with the button, then
  // slid right until roughly 8px of left gutter remains. Below ~336px there is
  // no room for either and the panel's own `max-w-[calc(100dvw-16px)]` takes
  // over the width; this clamp keeps it pinned 8px from the right edge.
  const maxRight = Math.max(VIEWPORT_MARGIN, viewportWidth - popoverWidth - VIEWPORT_MARGIN);
  const anchored = Math.max(VIEWPORT_MARGIN, Math.min(viewportWidth - anchor.right, maxRight));

  if (text && text.right > text.left) {
    // Largest `right` that still puts the panel's left edge clear of the text.
    // A two-page spread, a narrow window and a fixed-layout PDF all reach the
    // fallback through this one number rather than through a special case:
    // their text simply runs too far right to leave room.
    const clearOfText = viewportWidth - text.right - TEXT_CLEARANCE - popoverWidth;
    if (clearOfText >= VIEWPORT_MARGIN) {
      // Shift only as far as needed. When the anchored position already clears
      // the column, it stays exactly where it was, still reading as belonging
      // to the button it came from.
      return { top, right: Math.min(anchored, clearOfText), maxHeight, mode: "gutter" };
    }
  }
  return { top, right: anchored, maxHeight, mode: "anchored" };
}

function intersect(rect: PlacementRect, bounds: PlacementRect): PlacementRect | null {
  const left = Math.max(rect.left, bounds.left);
  const right = Math.min(rect.right, bounds.right);
  const top = Math.max(rect.top, bounds.top);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function grow(union: PlacementRect | null, rect: PlacementRect): PlacementRect {
  if (!union) return rect;
  return {
    left: Math.min(union.left, rect.left),
    top: Math.min(union.top, rect.top),
    right: Math.max(union.right, rect.right),
    bottom: Math.max(union.bottom, rect.bottom),
  };
}

/** The bits of foliate's view element this module reads. Structural on purpose. */
export interface TextRangeSource {
  lastLocation?: { range?: Range | null } | null;
}

/**
 * The bounding box of the text actually on screen right now, in window
 * coordinates — or null when nothing measurable is rendered.
 *
 * Deliberately not derived from the reading mode, the window width or any
 * setting: those are inputs to the layout, and the whole point is to read what
 * the layout produced. Two sources, tried in order, because the two renderers
 * put their text in genuinely different places:
 *
 *  - foliate keeps each chapter in a sandboxed iframe, so its rects need the
 *    frame's own offset added before they mean anything to us;
 *  - the plain-text reader is ordinary DOM in this document.
 */
export function measureRenderedTextRect({
  view,
  viewport,
}: {
  view: TextRangeSource | null | undefined;
  viewport: HTMLElement | null | undefined;
}): PlacementRect | null {
  if (!viewport) return null;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  // `lastLocation.range` is the slice of the chapter currently on screen, so
  // its client rects are the glyph boxes themselves — the real column width,
  // whatever produced it. On a two-page spread they span both columns, which
  // is exactly why a spread finds no gutter and lands on the fallback.
  const range = view?.lastLocation?.range;
  if (range) {
    try {
      const start = range.startContainer as Node | undefined;
      const doc = (start?.ownerDocument ?? (start as Document | undefined)) ?? null;
      const frame = doc?.defaultView?.frameElement as HTMLElement | null;
      const frameRect = frame?.getBoundingClientRect();
      const offsetX = frameRect?.left ?? 0;
      const offsetY = frameRect?.top ?? 0;
      let union: PlacementRect | null = null;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const visible = intersect(
          {
            left: rect.left + offsetX,
            top: rect.top + offsetY,
            right: rect.right + offsetX,
            bottom: rect.bottom + offsetY,
          },
          bounds,
        );
        if (visible) union = grow(union, visible);
      }
      if (union && union.right > union.left) return union;
    } catch {
      // A detached range from a chapter that has since been swapped out. Fall
      // through: an unmeasurable column is the fallback's job, not an error.
    }
  }

  // The plain-text reader scrolls its `<article>` horizontally in page mode, so
  // the article's own rect drifts with the scroll offset. The scroll port is
  // fixed, and the article's computed padding is the gutter the layout actually
  // applied, so the content box between them is the column.
  const port = viewport.querySelector<HTMLElement>(".text-book-reader");
  const article = port?.querySelector<HTMLElement>("article");
  if (port && article) {
    const style = getComputedStyle(article);
    const rect = port.getBoundingClientRect();
    const column = intersect(
      {
        left: rect.left + (parseFloat(style.paddingLeft) || 0),
        top: rect.top,
        right: rect.right - (parseFloat(style.paddingRight) || 0),
        bottom: rect.bottom,
      },
      bounds,
    );
    if (column && column.right > column.left) return column;
  }

  return null;
}
