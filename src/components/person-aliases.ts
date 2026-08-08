/**
 * What the "人物别名" table in the index manager (`PersonAliasesSection.tsx`)
 * needs to know about a book's alias rows, kept free of React and Tauri so
 * the rules can be tested on their own.
 *
 * The shapes here mirror `AliasEntryView` / `AliasGroupView` in
 * `src-tauri/src/ai/grounding/aliases.rs`.
 */

import {
  aiErrorMessageKey,
  getAiErrorCode,
  isAiRetryableError,
  isAiSettingsError,
} from "../utils/aiError.ts";

export interface AliasEntryView {
  id: string;
  alias: string;
  source: "auto" | "user";
  mentions: number;
  /**
   * `"name"` is matched by exact substring; `"description"` is matched by
   * cosine similarity against the question's embedding. The two behave
   * differently enough that the table has to render them differently — see
   * `personAliasRows`.
   */
  kind: "name" | "description";
  /**
   * The question the reader was asking when they taught this row. Only ever
   * set on a `"description"`; the backend stores `NULL` for names.
   */
  sourceQuery: string | null;
}

export interface AliasGroupView {
  canonical: string;
  entries: AliasEntryView[];
}

/** One table row: a person, and the two kinds of thing they can be called. */
export interface PersonAliasRow {
  canonical: string;
  names: AliasEntryView[];
  descriptions: AliasEntryView[];
}

/**
 * Split each group's entries by how they are matched, keeping both halves in
 * the same row.
 *
 * Descriptions belong to the person they name, not to a section of their own:
 * splitting them out would make a reader check two lists to learn every way
 * one character can be referred to. A group whose only entries are
 * descriptions therefore still gets a row — those rows were invisible (and so
 * undeletable) while this table filtered to `kind === "name"`, and a
 * description is the one thing in the table a rebuild cannot reconstruct.
 *
 * Anything that is not literally `"description"` counts as a name. An
 * unrecognised `kind` from a newer backend should render oddly, never
 * disappear.
 */
export function personAliasRows(groups: AliasGroupView[]): PersonAliasRow[] {
  return groups
    .map((group) => ({
      canonical: group.canonical,
      names: group.entries.filter((entry) => entry.kind !== "description"),
      descriptions: group.entries.filter((entry) => entry.kind === "description"),
    }))
    .filter((row) => row.names.length > 0 || row.descriptions.length > 0);
}

export interface AliasTableCounts {
  people: number;
  aliases: number;
  descriptions: number;
}

/** The three numbers in the count line, which names the two kinds separately. */
export function aliasTableCounts(rows: PersonAliasRow[]): AliasTableCounts {
  return {
    people: rows.length,
    aliases: rows.reduce((sum, row) => sum + row.names.length, 0),
    descriptions: rows.reduce((sum, row) => sum + row.descriptions.length, 0),
  };
}

/** How the row's "source" column reads, given every entry in the row. */
export function rowSource(row: PersonAliasRow): "auto" | "user" | "both" {
  const entries = [...row.names, ...row.descriptions];
  const hasAuto = entries.some((entry) => entry.source === "auto");
  const hasUser = entries.some((entry) => entry.source === "user");
  if (hasAuto && hasUser) return "both";
  return hasUser ? "user" : "auto";
}

/**
 * The failures `build_person_aliases` ends on that have something specific to
 * say to the reader.
 *
 * These arrive as prose, not as bare codes: `AppError` serialises through
 * `Display`, so what lands in `catch` is `"AI error: PERSON_ALIASES_AI_UNUSABLE"`.
 * Match by substring, the same way `getAiErrorCode` does.
 */
export const ALIAS_BUILD_ERROR_CODES = [
  "PERSON_ALIASES_AI_UNUSABLE",
  "PERSON_ALIASES_AI_INVALID",
  "PERSON_ALIASES_ALREADY_RUNNING",
] as const;

export type AliasBuildErrorCode = (typeof ALIAS_BUILD_ERROR_CODES)[number];

export interface AliasBuildErrorView {
  /** `"neutral"` for the one case where nothing actually broke. */
  tone: "danger" | "neutral";
  titleKey: string;
  bodyKey: string;
  canRetry: boolean;
  /** Whether a different model is the thing that would fix this. */
  canPickModel: boolean;
  /**
   * The raw string, kept only when nothing above could name the failure. It is
   * what a bug report needs, and it is the one case where the reader has no
   * better information than we do.
   */
  detail: string | null;
}

const K = "indexManager.aliases.buildError.";

/**
 * What to show instead of the raw rejection.
 *
 * A build runs for minutes; ending it with a stringified `AppError` spends all
 * of that patience on a code the reader cannot act on. Three of these failures
 * are ours and get their own sentence. The rest fall through to the generic AI
 * codes, which already have messages and already know whether a retry or a
 * settings trip is the way out — a missing API key should say so here exactly
 * as it does in the chat panel, not become "the build didn't finish".
 *
 * Only a failure no layer can name keeps its raw text, and even then behind a
 * disclosure rather than in the reader's face.
 */
export function aliasBuildError(error: unknown): AliasBuildErrorView {
  const message = String(error);
  const code = ALIAS_BUILD_ERROR_CODES.find((candidate) => message.includes(candidate));

  switch (code) {
    case "PERSON_ALIASES_AI_UNUSABLE":
      // Three independent samples all came back with names that are not the
      // book's. Retry first: attempts are independent, and the failure
      // correlates with how long the model reasoned, not with the book.
      return {
        tone: "danger",
        titleKey: `${K}unusableTitle`,
        bodyKey: `${K}unusableBody`,
        canRetry: true,
        canPickModel: true,
        detail: null,
      };
    case "PERSON_ALIASES_AI_INVALID":
      // Thrown on the first unparseable reply — it never enters the retry
      // loop — so the copy must not claim three tries were made. A model that
      // cannot hold the format rarely learns it on the second ask, which is
      // why picking another one leads here.
      return {
        tone: "danger",
        titleKey: `${K}invalidTitle`,
        bodyKey: `${K}invalidBody`,
        canRetry: true,
        canPickModel: true,
        detail: null,
      };
    case "PERSON_ALIASES_ALREADY_RUNNING":
      // Nothing broke: a pass for this book is in flight and the second one
      // was turned away. Red would be a lie, and a retry button would only
      // be turned away again.
      return {
        tone: "neutral",
        titleKey: `${K}alreadyRunningTitle`,
        bodyKey: `${K}alreadyRunningBody`,
        canRetry: false,
        canPickModel: false,
        detail: null,
      };
  }

  const aiCode = getAiErrorCode(error);
  if (aiCode) {
    return {
      tone: "danger",
      titleKey: `${K}unknownTitle`,
      bodyKey: aiErrorMessageKey(aiCode),
      canRetry: isAiRetryableError(aiCode),
      canPickModel: isAiSettingsError(aiCode),
      detail: null,
    };
  }

  return {
    tone: "danger",
    titleKey: `${K}unknownTitle`,
    bodyKey: `${K}unknownBody`,
    canRetry: true,
    canPickModel: false,
    detail: message,
  };
}

/** Same key the vector-retrieval toggle on the embedding settings page writes. */
export const VECTOR_RETRIEVAL_SETTING_KEY = "ai_vector_retrieval";

/**
 * Whether description matching is actually working right now, and if not, why.
 *
 * Description rows ride the vector-retrieval switch: with it off, or with no
 * embedding model configured, they stop matching while still sitting in the
 * table. Listed-but-inert is worse than not listed — the reader believes they
 * taught it and blames the answer on the model — so the table dims them and
 * says so. It does not hide them: nothing was lost, and flipping the switch
 * brings them back.
 *
 * `"unavailable"` outranks `"off"` because the settings toggle is itself
 * disabled without a model, so "the switch is off" would send a reader to a
 * control they cannot use.
 */
export type DescriptionMatching = "on" | "off" | "unavailable";

export function descriptionMatching(
  settings: Record<string, string>,
  settingsLoading: boolean,
  /** `ai_vector_retrieval_status`, or `null` before the first probe returns. */
  availability: { available: boolean } | null,
): DescriptionMatching {
  // Before either answer is in, say nothing. An unloaded settings map reads
  // as every switch off, and flashing a warning that the next render retracts
  // teaches the reader to distrust the warning.
  if (settingsLoading || availability === null) return "on";
  if (!availability.available) return "unavailable";
  return settings[VECTOR_RETRIEVAL_SETTING_KEY] === "true" ? "on" : "off";
}
