import type { ReaderInteraction } from "../../components/reader-interaction";
import type { SentenceLocation } from "./read-aloud-follow";

/**
 * The bookmark ear collects an answer whose sentence a page turn took away
 * (design §12): a learning card stands beside its sentence, and once that
 * sentence is no longer on the page the card has nothing to stand beside.
 *
 * Only a definite "off the page" folds a card. `null` means the sentence could
 * not be placed at all (nothing rendered yet, a fixed-layout page with no
 * visible text range, a document replaced mid-measure), and a card the reader
 * may still be looking at is never hidden on a guess.
 */
export function isAnchorOffPage(location: SentenceLocation): boolean {
  if (location === "other-chapter") return true;
  if (location === null) return false;
  return !(location.startVsVisibleEnd < 0 && location.endVsVisibleStart > 0);
}

/**
 * Cards that can follow their sentence at all: ones opened on a Foliate page,
 * with a range to place. A text book's card has no range on a paginated page.
 */
export function canFoldWithPage(interaction: ReaderInteraction): boolean {
  return interaction.source === "foliate" && Boolean(interaction.location);
}

export interface FoldableCard {
  id: string;
  folded?: boolean;
  loading?: boolean;
}

/**
 * What the ear shows for the folded cards: whether there are any, and whether
 * one of them is still being written (the dot breathes until it is done).
 */
export function foldedEar(cards: readonly FoldableCard[]): { count: number; writing: boolean } {
  const folded = cards.filter((card) => card.folded);
  return { count: folded.length, writing: folded.some((card) => card.loading) };
}
