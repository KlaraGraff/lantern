import type { ReadingStatsDashboard, ReadingStatsQuery } from "./types";

/**
 * Which empty screen an empty dashboard gets.
 *
 * The full-page "your reading history starts here" screen has no header, so
 * no range, book or view control. That is right only when there really is no
 * history at all. An empty *filtered* view ("this year" in January, one book
 * over the last 30 days) still needs those controls to get anywhere else, so it
 * keeps the normal page and only its lists are empty.
 *
 * - `"none"`: the dashboard has sessions; nothing is empty.
 * - `"firstUse"`: no sessions in any range for any book.
 * - `"filtered"`: no sessions in this view, but some exist outside it.
 * - `"unknown"`: this view is empty and filtered, so whether any history
 *   exists has to be asked with the unfiltered query (`ALL_TIME_QUERY`).
 */
export type ReadingStatsEmptyState = "none" | "firstUse" | "filtered" | "unknown";

export const ALL_TIME_QUERY: ReadingStatsQuery = { range: "all", bookId: null };

export function readingStatsEmptyState(
  query: ReadingStatsQuery,
  dashboard: Pick<ReadingStatsDashboard, "overview">,
  allTimeSessionCount?: number,
): ReadingStatsEmptyState {
  if (dashboard.overview.sessionCount > 0) return "none";
  if (query.range === ALL_TIME_QUERY.range && query.bookId === ALL_TIME_QUERY.bookId) return "firstUse";
  if (allTimeSessionCount === undefined) return "unknown";
  return allTimeSessionCount > 0 ? "filtered" : "firstUse";
}
