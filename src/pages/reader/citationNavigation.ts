import type { CitedSource } from "../../hooks/useAiChat";

/**
 * Everything a jump needs to find a passage in the book.
 *
 * `CitedSource` — a `[S1]` marker pointing into the book being read — satisfies
 * this as it stands. A `[Q1]` quote from another book satisfies it too, and
 * additionally carries the text around the sentence: it came out of the search
 * index rather than off the page, so it may not match the rendering character
 * for character, and the surrounding text is what picks the right candidate.
 * See `quoteAnchoring`.
 */
export interface AnchorTarget
  extends Pick<
    CitedSource,
    "sectionIndex" | "sectionHref" | "snippet" | "fallbackSnippet" | "charStart" | "charEnd"
  > {
  prefix?: string;
  suffix?: string;
}

/**
 * How close a jump got.
 *
 * `"section"` is a real success — the reader is in the right chapter — but not
 * the same thing as landing on the line, and a caller that promised a specific
 * sentence owes them a word about the difference.
 */
export type AnchorOutcome = "anchored" | "section" | false;

function normalizeWhitespace(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function citationSearchProbes(
  source: Pick<CitedSource, "snippet" | "fallbackSnippet">,
): string[] {
  const exact = normalizeWhitespace(source.snippet);
  const fallback = normalizeWhitespace(source.fallbackSnippet);
  return [exact, fallback]
    .filter((probe, index, probes) => probe.length > 0 && probes.indexOf(probe) === index);
}
