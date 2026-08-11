/**
 * Which reader controls survive in the header when the header is 390px wide.
 *
 * The wide header carries up to seven buttons plus a two-line book title. At
 * phone width they do not fit, and shrinking all seven equally is the wrong
 * answer twice over: it makes every one of them harder to hit, and it still
 * leaves the title nothing to occupy. So the header keeps the controls a reader
 * reaches for *mid-page* and folds the rest behind one ⋯ button.
 *
 * Kept: back (the way out of the book), the TOC (where am I, take me
 * elsewhere), and the AI panel (the thing this reader is for). Folded:
 * typography, whole-book search, traces, read-aloud — each a deliberate
 * excursion rather than a reflex, and each one the reader is willing to spend a
 * second tap on. Typography is the closest call: Apple Books keeps `AA` in the
 * bar. It is folded here because it is tuned once at the start of a session and
 * then left alone, and because a fourth 44px target costs the title the ~40px
 * that decides whether a book name is readable or three characters and an
 * ellipsis.
 *
 * The decorative book-cover square is dropped outright rather than folded: it
 * carries no information the title beside it does not.
 */
export type ReaderToolbarAction = "typography" | "search" | "traces" | "readAloud";

export interface ReaderToolbarInput {
  /** Viewport width, not input type — a 900px touchscreen keeps the full header. */
  narrow: boolean;
  supportsSearch: boolean;
  supportsCfiNavigation: boolean;
  readAloudAvailable: boolean;
}

/**
 * The controls the ⋯ sheet lists, in the order it lists them. Empty on a wide
 * viewport, where every control has a button of its own and there is no ⋯ at
 * all — so an empty result is also the answer to "should the ⋯ button render".
 */
export function readerToolbarOverflow({
  narrow,
  supportsSearch,
  supportsCfiNavigation,
  readAloudAvailable,
}: ReaderToolbarInput): ReaderToolbarAction[] {
  if (!narrow) return [];
  const actions: ReaderToolbarAction[] = ["typography"];
  if (supportsSearch) actions.push("search");
  if (supportsCfiNavigation) actions.push("traces");
  if (readAloudAvailable) actions.push("readAloud");
  return actions;
}
