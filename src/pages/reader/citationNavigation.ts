import type { CitedSource } from "../../hooks/useAiChat";

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
