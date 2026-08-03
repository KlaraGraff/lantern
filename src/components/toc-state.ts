/**
 * Per-book persistence for the table-of-contents side panel: which nodes are
 * expanded, and where the panel was last scrolled. Rows are identified by
 * their position in the flattened chapter list (`page` in `TableOfContents`),
 * which is stable across sessions because a book's TOC is fixed to its file.
 */

export interface TocSavedState {
  expandedPages: number[];
  /** `undefined` means nothing was ever saved — distinct from a saved `0`. */
  scrollTop: number | undefined;
}

export const tocStateSettingKeys = {
  expanded: "toc_expanded",
  scroll: "toc_scroll",
} as const;

export function parseTocSavedState(bookSettings: Record<string, string>): TocSavedState {
  const expandedRaw = bookSettings[tocStateSettingKeys.expanded];
  let expandedPages: number[] = [];
  if (expandedRaw) {
    try {
      const parsed: unknown = JSON.parse(expandedRaw);
      if (Array.isArray(parsed)) {
        expandedPages = parsed.filter((value): value is number => Number.isInteger(value));
      }
    } catch {
      // A corrupt row falls back to the default collapsed state.
    }
  }
  const scrollRaw = bookSettings[tocStateSettingKeys.scroll];
  const scrollParsed = scrollRaw !== undefined ? Number(scrollRaw) : undefined;
  const scrollTop = scrollParsed !== undefined && Number.isFinite(scrollParsed) && scrollParsed >= 0
    ? scrollParsed
    : undefined;
  return { expandedPages, scrollTop };
}

export function serializeExpandedPages(pages: Iterable<number>): string {
  return JSON.stringify(Array.from(pages).sort((a, b) => a - b));
}

/**
 * Union a restored expanded-node set with another set of pages (typically the
 * current chapter's ancestor path), so restoring saved state can never
 * collapse the path to the chapter the reader is actually on.
 */
export function mergeExpandedPages(
  base: Iterable<number>,
  additions: Iterable<number>,
): Set<number> {
  const next = new Set(base);
  for (const page of additions) next.add(page);
  return next;
}
