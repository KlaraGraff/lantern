import {
  planCfiHighlightRemoval,
  planCfiHighlightMutation,
  planTextHighlightRemoval,
  planTextHighlightMutation,
  type HighlightMutationPlan,
} from "../../components/highlight-ranges";
import type { ReaderInteraction } from "../../components/reader-interaction";
import type { Highlight } from "../../hooks/useBookmarks";

/**
 * Which planner an interaction's marks go through. Text books address a range
 * by character offsets and EPUB/PDF by CFI, so the two stores can never be
 * planned against each other — the interaction's own `source` is the only
 * thing that says which one this location belongs to.
 */
export async function highlightMutationPlan(
  interaction: ReaderInteraction,
  highlights: Highlight[],
): Promise<HighlightMutationPlan | null> {
  return interaction.source === "text"
    ? planTextHighlightMutation(interaction.location, highlights, "yellow", interaction.text)
    : planCfiHighlightMutation(interaction.location, highlights, "yellow", interaction.text);
}

export async function highlightRemovalPlan(
  interaction: ReaderInteraction,
  highlights: Highlight[],
): Promise<HighlightMutationPlan | null> {
  return interaction.source === "text"
    ? planTextHighlightRemoval(interaction.location, highlights)
    : planCfiHighlightRemoval(interaction.location, highlights);
}
