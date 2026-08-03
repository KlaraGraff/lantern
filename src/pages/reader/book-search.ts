/**
 * Pure logic for the P1.2 book search panel — kept separate from
 * `BookSearchPanel.tsx` so the scope-filtering and CFI-containment math can
 * be unit tested without a live `view.search()` generator or a mounted
 * component. The engine (`view.search()`) already groups matches by chapter
 * as it streams them (see `FoliateSearchYield` in `foliate-types.ts`), so
 * there is no separate "group by chapter" step here — the interesting logic
 * starts once those groups exist.
 */
import type { FoliateSearchHit } from "./foliate-types";

/** Minimal shape of foliate-js's vendored `epubcfi.js` needed for containment checks. */
export interface CfiModule {
  collapse(cfi: string, toEnd?: boolean): string;
  compare(left: string, right: string): number;
}

export type BookSearchScope = "book" | "highlights" | "vocab";

/** One chapter's worth of search hits, as accumulated from `view.search()`'s yields. */
export interface SearchChapterGroup {
  label: string;
  hits: FoliateSearchHit[];
}

/** An empty/whitespace-only query is a no-op, not a full-book scan. */
export function isSearchableQuery(query: string): boolean {
  return query.trim().length > 0;
}

function cfiBounds(location: string, cfi: CfiModule): { start: string; end: string } | null {
  try {
    return { start: cfi.collapse(location), end: cfi.collapse(location, true) };
  } catch {
    return null;
  }
}

/**
 * Whether `hitCfi` falls inside `location`. `location` may be a range CFI
 * (a highlight's `cfi_range`) or a point CFI (a vocab word's `cfi`) — both
 * collapse to a `[start, end]` pair, a point simply collapsing to itself, so
 * the same containment check covers both scopes without special-casing.
 */
export function cfiFallsWithin(hitCfi: string, location: string, cfi: CfiModule): boolean {
  const bounds = cfiBounds(location, cfi);
  if (!bounds) return false;
  try {
    return cfi.compare(bounds.start, hitCfi) <= 0 && cfi.compare(hitCfi, bounds.end) <= 0;
  } catch {
    return false;
  }
}

/**
 * Narrows the raw chapter-grouped result stream to hits that land inside one
 * of `scopeLocations` (highlight ranges for the "highlights" scope, vocab
 * CFIs for "vocab") — "book" scope is the identity. Chapters left with no
 * hits after filtering are dropped so the list only ever shows chapters that
 * actually have something under the active scope.
 */
export function filterGroupsByScope(
  groups: readonly SearchChapterGroup[],
  scope: BookSearchScope,
  scopeLocations: readonly string[],
  cfi: CfiModule,
): SearchChapterGroup[] {
  if (scope === "book") {
    return groups.map((group) => ({ label: group.label, hits: [...group.hits] }));
  }
  return groups
    .map((group) => ({
      label: group.label,
      hits: group.hits.filter((hit) =>
        scopeLocations.some((location) => cfiFallsWithin(hit.cfi, location, cfi))),
    }))
    .filter((group) => group.hits.length > 0);
}

/** Total hit count across every chapter group — the result-count line in the panel. */
export function countHits(groups: readonly SearchChapterGroup[]): number {
  return groups.reduce((total, group) => total + group.hits.length, 0);
}

export interface SearchExcerptParts {
  pre: string;
  match: string;
  post: string;
}

/** Defensive normalization of the engine's excerpt shape — `pre`/`match`/`post` render as plain text with `match` emphasized. */
export function normalizeExcerpt(
  excerpt: { pre?: string; match?: string; post?: string } | null | undefined,
): SearchExcerptParts {
  return {
    pre: excerpt?.pre ?? "",
    match: excerpt?.match ?? "",
    post: excerpt?.post ?? "",
  };
}
