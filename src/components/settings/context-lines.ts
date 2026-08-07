/**
 * Pure helpers for the "context lines" sub-row under vector retrieval
 * (`EmbeddingSettings.tsx`). Framework-free so the enable/disable rules can
 * be tested without a DOM. See docs/impls/contextual-retrieval.md.
 */

/** Settings-table key. Mirrors `ai_vector_retrieval`'s string-boolean shape. */
export const CONTEXT_LINES_SETTING_KEY = "ai_context_lines_enabled";

/**
 * The feature defaults to on (see the plan's "原文永不改变" principle — a
 * wrong context line can only hurt ranking, never put words in the reader's
 * mouth, so there is nothing to protect against by defaulting it off). A
 * settings row that has never been written reads as enabled; only an
 * explicit `"false"` turns it off.
 */
export function contextLinesEnabled(settings: Record<string, string>): boolean {
  return settings[CONTEXT_LINES_SETTING_KEY] !== "false";
}

/**
 * The sub-row is disabled whenever vector retrieval itself is off — context
 * lines only ever feed the vector input, so they have nothing to do without
 * it. This reads `ai_vector_retrieval` directly (not the embedding probe's
 * `availability.available`): the row cares about the switch above it, not
 * about whether a search model happens to be reachable right now.
 */
export function contextLinesRowDisabled(settings: Record<string, string>): boolean {
  return settings.ai_vector_retrieval !== "true";
}
