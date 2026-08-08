import { defaultUrlTransform } from "react-markdown";
import type { CitedSource, QuotedSource } from "../hooks/useAiChat";

const CITATION_SCHEME = "lantern-citation:";
const QUOTE_SCHEME = "lantern-quote:";

/**
 * Let the internal schemes through react-markdown's URL sanitiser, which drops
 * every protocol it does not recognise. Kept out of the component so a test can
 * feed it to a real render and check the schemes survive GFM parsing.
 */
export function citationUrlTransform(url: string): string {
  return url.startsWith(CITATION_SCHEME) || url.startsWith(QUOTE_SCHEME)
    ? url
    : defaultUrlTransform(url);
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

/**
 * `[Q1]` example sentences, handled the same way as `[S1]` citations and kept
 * on a separate scheme.
 *
 * The two are numbered independently by the backend, so a single scheme could
 * not say whether `1` meant the first excerpt from this book or the first
 * sentence from another one — and clicking them does different things.
 *
 * Only quotes the model actually used are listed under the answer: the backend
 * offers several and tells the model to use none if none fits, so an offered
 * quote that never appears in the text is not an example of anything.
 */
export function quotedSourcesInContent(content: string, quotes: QuotedSource[]): QuotedSource[] {
  const markers = new Set([...content.matchAll(/\[Q(\d+)\]/g)].map((match) => `Q${match[1]}`));
  return quotes.filter((quote) => markers.has(quote.marker));
}

export function markdownWithQuoteLinks(content: string, quotes: QuotedSource[]): string {
  const quoteMarkers = new Set(quotes.map((quote) => quote.marker));
  return content.replace(/\[Q(\d+)\]/g, (marker, number: string) => {
    const quoteMarker = `Q${number}`;
    return quoteMarkers.has(quoteMarker)
      ? `[${quoteMarker}](${QUOTE_SCHEME}${quoteMarker})`
      : marker;
  });
}

export function quoteMarkerFromHref(href: string | undefined): string | undefined {
  return href?.startsWith(QUOTE_SCHEME) ? href.slice(QUOTE_SCHEME.length) : undefined;
}
