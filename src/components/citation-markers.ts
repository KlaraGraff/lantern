import type { CitedSource } from "../hooks/useAiChat";

export function citedSourcesInContent(content: string, sources: CitedSource[]): CitedSource[] {
  const markers = new Set([...content.matchAll(/\[S(\d+)\]/g)].map((match) => `S${match[1]}`));
  return sources.filter((source) => markers.has(source.marker));
}

export function markdownWithCitationLinks(content: string, sources: CitedSource[]): string {
  const sourceMarkers = new Set(sources.map((source) => source.marker));
  return content.replace(/\[S(\d+)\]/g, (marker, number: string) => {
    const sourceMarker = `S${number}`;
    return sourceMarkers.has(sourceMarker)
      ? `[${sourceMarker}](lantern-citation:${sourceMarker})`
      : marker;
  });
}

export function citationMarkerFromHref(href: string | undefined): string | undefined {
  return href?.startsWith("lantern-citation:") ? href.slice("lantern-citation:".length) : undefined;
}
