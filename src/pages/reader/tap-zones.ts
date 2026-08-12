/**
 * Where a tap on the page lands, on a phone.
 *
 * A phone has no margins to click and no keyboard to page with, so the page
 * itself has to carry the three things a reader does most: back a page, forward
 * a page, and "show me the controls". Splitting the width in three is the
 * arrangement every touch reader converged on — the two outer thirds page, the
 * middle one raises the chrome — and it is the one a reader already knows
 * before they open this app.
 *
 * A pure function, deliberately: this is the only place the split is decided,
 * so the one-handed mode is a parameter here and nowhere else. The caller
 * passes the *iframe's* client width and the event's `clientX`, which share a
 * coordinate system — the listeners live inside foliate's chapter document, so
 * no host offset is involved and none should be added.
 */
export type TapZone = "previous" | "menu" | "next";

/**
 * `x` outside `[0, width]` is clamped rather than rejected: WebKit reports
 * coordinates a fraction of a pixel past the edge on a scaled document, and the
 * honest answer for a tap at -0.4px is "the left zone", not "no zone at all".
 * A width of zero or NaN — a document that has not laid out yet — answers
 * `menu`, the one zone that cannot lose the reader their place.
 *
 * `oneHand` is Apple Books' "Both Margins Advance": the thumb holding the
 * phone reaches one edge only, so both outer zones turn forward and going back
 * is the swipe's job. The middle zone still raises the chrome — a one-handed
 * reader has not lost the menu.
 */
export function classifyReaderTap(x: number, width: number, oneHand = false): TapZone {
  if (!(width > 0)) return "menu";
  const clamped = Math.min(Math.max(x, 0), width);
  if (clamped < width / 3) return oneHand ? "next" : "previous";
  if (clamped >= (width * 2) / 3) return "next";
  return "menu";
}

/**
 * The same split, for a reader that renders in the host document.
 *
 * Text books (txt/md/html) do not go through foliate and have no iframe, so
 * their `clientX` is a window coordinate while their page is one box inside
 * that window. Measuring against the window would put the zone boundaries in
 * the wrong place the moment anything sits beside the page — a docked side
 * panel on a wide window, or the left inset of a landscape phone. The box is
 * the page, so the box is what the thirds are cut from.
 *
 * An unmeasured box (zero width, or a rect read before layout) falls through to
 * `menu` exactly as an unmeasured document does.
 */
export function classifyReaderTapInBox(
  clientX: number,
  box: { left: number; width: number },
  oneHand = false,
): TapZone {
  return classifyReaderTap(clientX - box.left, box.width, oneHand);
}
