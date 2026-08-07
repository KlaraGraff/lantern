import type { Highlight } from "../hooks/useBookmarks";
import type { AutoHighlight } from "../hooks/useAutoHighlights";

/**
 * The highlights list holds two kinds of thing that are the same shape: ranges
 * the reader drew, and ranges derived from what they looked up or quoted. They
 * share one chronological order — this module builds it and narrows it, and
 * nothing here ever reorders by kind.
 *
 * That is a product rule, not an implementation detail: a list that floats
 * manual highlights to the top would be answering a question ("which are
 * mine?") that the source filter already answers, at the cost of the one thing
 * the list is for — where you were in the book when you marked it.
 */
export type HighlightRow =
  | { kind: "manual"; key: string; createdAt: number; highlight: Highlight }
  | { kind: "auto"; key: string; createdAt: number; auto: AutoHighlight };

export type SourceFilter = "all" | "manual" | "auto";

export interface RowFilters {
  source: SourceFilter;
  /** Colour is a property only a drawn highlight has — see `filterHighlightRows`. */
  color: string | null;
  search: string;
}

/** Newest first. Ties break on the row key so renders don't shuffle. */
export function mergeHighlightRows(
  highlights: readonly Highlight[],
  autos: readonly AutoHighlight[],
): HighlightRow[] {
  const rows: HighlightRow[] = [
    ...highlights.map((highlight): HighlightRow => ({
      kind: "manual",
      key: `h:${highlight.id}`,
      createdAt: highlight.created_at,
      highlight,
    })),
    ...autos.map((auto): HighlightRow => ({
      kind: "auto",
      key: `a:${auto.anchor}`,
      createdAt: auto.created_at,
      auto,
    })),
  ];
  return rows.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
}

function rowText(row: HighlightRow): string {
  return row.kind === "manual" ? row.highlight.text_content ?? "" : row.auto.text;
}

export function filterHighlightRows(
  rows: readonly HighlightRow[],
  { source, color, search }: RowFilters,
): HighlightRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (source === "manual" && row.kind !== "manual") return false;
    if (source === "auto" && row.kind !== "auto") return false;
    // Picking a colour is picking among drawn highlights. An automatic row has
    // no colour to match, so it cannot survive the question.
    if (color && (row.kind !== "manual" || row.highlight.color !== color)) return false;
    if (!needle) return true;
    // The looked-up word is searchable too: it is why the row exists, even when
    // the sentence it sits in never mentions it in that form.
    const label = row.kind === "auto" ? row.auto.label ?? "" : "";
    return `${rowText(row)} ${label}`.toLowerCase().includes(needle);
  });
}
