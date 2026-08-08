/**
 * What the "人物别名" table in the index manager (`PersonAliasesSection.tsx`)
 * needs to know about a book's alias rows, kept free of React and Tauri so
 * the rules can be tested on their own.
 *
 * The shapes here mirror `AliasEntryView` / `AliasGroupView` in
 * `src-tauri/src/ai/grounding/aliases.rs`.
 */

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
