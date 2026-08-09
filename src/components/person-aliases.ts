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

/**
 * How many times this person's canonical name occurs in the book.
 *
 * The backend stores it per row but computes it from the canonical, so every
 * entry in a group carries the same number (see `list_person_aliases`'s doc
 * comment). Reading it off whichever entry exists is therefore exact, not an
 * approximation — and a row always has at least one entry, or `personAliasRows`
 * would have dropped it.
 *
 * It is the single most useful number on the row: a name the model invented
 * lands near zero, and a common word mistaken for a name (`Young`) lands
 * absurdly high, because `count_mentions` is a case-insensitive
 * `LIKE '%Young%'` that hits every "young man" in the book.
 */
export function rowMentions(row: PersonAliasRow): number {
  return row.names[0]?.mentions ?? row.descriptions[0]?.mentions ?? 0;
}

/** One person an ambiguous alias could be pointing at. */
export interface AmbiguityCandidate {
  canonical: string;
  mentions: number;
  /**
   * The `(alias, canonical)` row itself. "改成只指 X" is a delete of every
   * *other* candidate's row, so the bridge card needs the ids, not just the
   * names.
   */
  entryId: string;
}

/** One alias text that two or more people in this book answer to. */
export interface AliasAmbiguity {
  alias: string;
  /** Most-mentioned first — the same order `resolve()` picks its default in. */
  candidates: AmbiguityCandidate[];
}

/**
 * The aliases that point at more than one person.
 *
 * No backend call: `list_person_aliases` already returns every row, and an
 * ambiguity is just the same alias text appearing under two canonicals. The
 * table could not show it before because it groups *by canonical* — an
 * ambiguity is a relation between two rows, and two identical-looking chips in
 * two different rows is not something a reader will ever connect.
 *
 * Descriptions are excluded deliberately. `resolve()`'s exact-match scan reads
 * `kind = 'name'` only (see `alias_groups`), so a phrase taught twice is not an
 * ambiguity anything acts on, and flagging it would send the reader to delete a
 * row that was never in the way.
 *
 * The candidate order mirrors `resolve()`: it picks the highest-`mentions`
 * canonical as `default_canonical`, so `candidates[0]` is the name the
 * disclosure line above an answer will actually quote.
 */
export function aliasAmbiguities(rows: PersonAliasRow[]): AliasAmbiguity[] {
  const byAlias = new Map<string, AmbiguityCandidate[]>();
  for (const row of rows) {
    for (const entry of row.names) {
      const candidates = byAlias.get(entry.alias) ?? [];
      candidates.push({
        canonical: row.canonical,
        mentions: rowMentions(row),
        entryId: entry.id,
      });
      byAlias.set(entry.alias, candidates);
    }
  }
  return [...byAlias.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([alias, candidates]) => ({
      alias,
      candidates: [...candidates].sort(
        (a, b) => b.mentions - a.mentions || a.canonical.localeCompare(b.canonical),
      ),
    }))
    .sort(
      (a, b) =>
        b.candidates[0].mentions - a.candidates[0].mentions || a.alias.localeCompare(b.alias),
    );
}

/** Which alias texts in this table are ambiguous, for badging the chips. */
export function ambiguousAliasSet(ambiguities: AliasAmbiguity[]): Set<string> {
  return new Set(ambiguities.map((ambiguity) => ambiguity.alias));
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

/**
 * How many people the table shows before it starts folding.
 *
 * Eight compact rows are about a screen. The number is a layout fact, not a
 * threshold anyone has to defend — nothing downstream reads it.
 */
export const ALIAS_TABLE_VISIBLE_PEOPLE = 8;

export interface AliasTableSections {
  visible: PersonAliasRow[];
  folded: PersonAliasRow[];
  /**
   * Every folded person occurs fewer than this many times. `null` when nothing
   * is folded.
   *
   * The fold line has to say what is behind it. "还有 31 人" alone tells a
   * reader nothing about whether they are missing something, so they open it
   * every time — which is the same as not folding at all.
   */
  foldedBelowMentions: number | null;
}

/**
 * Split the table into the people shown and the people folded away.
 *
 * Rows are already sorted by mentions descending by the backend, and that order
 * is preserved: the fold is a cut, not a re-sort.
 *
 * A person caught up in an ambiguity is never folded, however few times the
 * book mentions them. `Franz Vesely-Frankl` appears six times and is the whole
 * reason this feature exists — folding him away by rank would hide the one row
 * the reader opened this table to find.
 */
export function aliasTableSections(
  rows: PersonAliasRow[],
  ambiguities: AliasAmbiguity[],
  limit: number = ALIAS_TABLE_VISIBLE_PEOPLE,
): AliasTableSections {
  const flagged = new Set(
    ambiguities.flatMap((ambiguity) => ambiguity.candidates.map((candidate) => candidate.canonical)),
  );
  const visible: PersonAliasRow[] = [];
  const folded: PersonAliasRow[] = [];
  let ranked = 0;
  for (const row of rows) {
    if (flagged.has(row.canonical)) {
      visible.push(row);
      continue;
    }
    if (ranked < limit) {
      ranked += 1;
      visible.push(row);
      continue;
    }
    folded.push(row);
  }
  // "都在 N 次以下" has to stay true of every folded row, so the bound is one
  // past the busiest of them rather than the last visible row's count — those
  // differ as soon as an ambiguous straggler is pulled up into `visible`.
  const foldedBelowMentions = folded.length
    ? Math.max(...folded.map(rowMentions)) + 1
    : null;
  return { visible, folded, foldedBelowMentions };
}

/** The segmented control above the table. */
export type AliasFilter = "all" | "taught" | "flagged";

/**
 * The rows a search box and a filter leave standing.
 *
 * Search reads both columns — a reader looking for 达西 and a reader looking
 * for `Mr. Darcy` are the same reader, and which of the two they remember is
 * not something the table gets to decide.
 */
export function filterAliasRows(
  rows: PersonAliasRow[],
  ambiguities: AliasAmbiguity[],
  query: string,
  filter: AliasFilter,
): PersonAliasRow[] {
  const needle = query.trim().toLowerCase();
  const flagged = new Set(
    ambiguities.flatMap((ambiguity) => ambiguity.candidates.map((candidate) => candidate.canonical)),
  );
  return rows.filter((row) => {
    if (filter === "flagged" && !flagged.has(row.canonical)) return false;
    if (filter === "taught" && rowSource(row) === "auto") return false;
    if (!needle) return true;
    if (row.canonical.toLowerCase().includes(needle)) return true;
    return [...row.names, ...row.descriptions].some((entry) =>
      entry.alias.toLowerCase().includes(needle),
    );
  });
}

/** A person the "指向谁" field can complete to. */
export interface CanonicalCandidate {
  canonical: string;
  mentions: number;
}

/**
 * The people already in this book's table whose name starts with, or contains,
 * what has been typed.
 *
 * The field this feeds used to be free text, and `add_person_alias` stores
 * whatever it is given: a typo lands a row with `mentions = 0` that looks
 * exactly like a working one and never matches anything for the life of the
 * book. Completing from names known to occur in the text turns that silent
 * failure into a visible choice.
 *
 * Prefix matches lead: someone typing `Mrs. Gard` means `Mrs. Gardiner`, not
 * whichever longer name happens to contain the same letters.
 */
export function canonicalCandidates(
  rows: PersonAliasRow[],
  query: string,
  limit = 6,
): CanonicalCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { candidate: CanonicalCandidate; prefix: boolean }[] = [];
  for (const row of rows) {
    const lower = row.canonical.toLowerCase();
    if (!lower.includes(needle)) continue;
    scored.push({
      candidate: { canonical: row.canonical, mentions: rowMentions(row) },
      prefix: lower.startsWith(needle),
    });
  }
  return scored
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        b.candidate.mentions - a.candidate.mentions ||
        a.candidate.canonical.localeCompare(b.candidate.canonical),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Whether what was typed is already one of the book's known names, exactly. */
export function isKnownCanonical(rows: PersonAliasRow[], query: string): boolean {
  const typed = query.trim();
  return typed.length > 0 && rows.some((row) => row.canonical === typed);
}

/** How the row's "source" column reads, given every entry in the row. */
export function rowSource(row: PersonAliasRow): "auto" | "user" | "both" {
  const entries = [...row.names, ...row.descriptions];
  const hasAuto = entries.some((entry) => entry.source === "auto");
  const hasUser = entries.some((entry) => entry.source === "user");
  if (hasAuto && hasUser) return "both";
  return hasUser ? "user" : "auto";
}

export interface AliasSourceCounts {
  auto: number;
  user: number;
}

/**
 * Rows by who put them there, for the rebuild confirmation.
 *
 * The confirmation has to name both numbers because the honest version of it is
 * "the 72 automatic rows get redone, your 6 are left alone" — a rebuild deletes
 * `source = 'auto'` and nothing else (`clear_auto_aliases`), and a reader who
 * believes otherwise will avoid a button that is safe.
 */
export function aliasSourceCounts(rows: PersonAliasRow[]): AliasSourceCounts {
  let auto = 0;
  let user = 0;
  for (const row of rows) {
    for (const entry of [...row.names, ...row.descriptions]) {
      if (entry.source === "user") user += 1;
      else auto += 1;
    }
  }
  return { auto, user };
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
      //
      // The button stays — a reader who wants a different model should be able
      // to reach one — but the copy no longer *recommends* one. Measured
      // across three configurations, a bigger model was not steadier: the
      // small model returned a usable table 6/6 on the first ask, the larger
      // configured one lost 3 builds in 18, and raising reasoning effort was
      // the only knob that made things reliably worse. See
      // docs/impls/grounding-retrieval-validation.md §2.
      return {
        tone: "danger",
        titleKey: `${K}unusableTitle`,
        bodyKey: `${K}unusableBody`,
        canRetry: true,
        canPickModel: true,
        detail: null,
      };
    case "PERSON_ALIASES_AI_INVALID":
      // Now raised only after three unparseable replies in a row: the parse
      // failure used to skip the retry loop entirely, which cost 3 builds in
      // 18 on a real library while the case the loop *did* cover cost none.
      // So the copy may claim three tries, and a model that misses the format
      // three times running is a fair reason to offer another one.
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
