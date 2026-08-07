/**
 * Pure helpers for the "context lines" row on the embedding settings page
 * (`EmbeddingSettings.tsx`). Framework-free so the rules can be tested
 * without a DOM. See docs/impls/contextual-retrieval.md.
 */

/**
 * Settings-table key. Owned by the automatic-analysis registry
 * (`auto_analysis_enabled_<job id>`, job id `grounding_context`), not by this
 * page: the console is the one place that lists everything allowed to spend
 * the reader's quota unprompted, so it owns the answer to "is this on". This
 * row is a second door onto the same switch, put here because it is where
 * someone setting up retrieval goes looking. Migration 053 carried the old
 * page-local key across. Same string-boolean shape as `ai_vector_retrieval`.
 */
export const CONTEXT_LINES_SETTING_KEY = "auto_analysis_enabled_grounding_context";

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

/*
 * There used to be a `contextLinesRowDisabled` here, greying the row out
 * whenever `ai_vector_retrieval` was off, on the true-at-the-time premise
 * that the identity sentence had exactly one reader: the embedding input.
 * It has two now — it also fills `seg_context` in the full-text index, which
 * every reader has whether or not they ever configure an embedding provider.
 * Withholding the feature from those readers was withholding it from the
 * ones with the least search to begin with.
 */
