import { defaultUrlTransform } from "react-markdown";
import type { CitedSource } from "../hooks/useAiChat";

const CITATION_SCHEME = "lantern-citation:";

/**
 * Let the citation scheme through react-markdown's URL sanitiser, which drops
 * every protocol it does not recognise. Kept out of the component so a test can
 * feed it to a real render and check the scheme survives GFM parsing.
 */
export function citationUrlTransform(url: string): string {
  return url.startsWith(CITATION_SCHEME) ? url : defaultUrlTransform(url);
}

export function citedSourcesInContent(content: string, sources: CitedSource[]): CitedSource[] {
  const markers = new Set([...content.matchAll(/\[S(\d+)\]/g)].map((match) => `S${match[1]}`));
  return sources.filter((source) => markers.has(source.marker));
}

export function markdownWithCitationLinks(content: string, sources: CitedSource[]): string {
  const sourceMarkers = new Set(sources.map((source) => source.marker));
  return content.replace(/\[S(\d+)\]/g, (marker, number: string) => {
    const sourceMarker = `S${number}`;
    return sourceMarkers.has(sourceMarker)
      ? `[${sourceMarker}](${CITATION_SCHEME}${sourceMarker})`
      : marker;
  });
}

export function citationMarkerFromHref(href: string | undefined): string | undefined {
  return href?.startsWith(CITATION_SCHEME) ? href.slice(CITATION_SCHEME.length) : undefined;
}
