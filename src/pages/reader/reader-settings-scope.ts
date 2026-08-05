import type { ReaderSettingsState } from "../../components/ReaderSettings.tsx";

export const perBookSettingKeys = {
  theme: "theme",
  font: "font",
  fontSize: "font_size",
  lineSpacing: "line_spacing",
  wordSpacing: "word_spacing",
  charSpacing: "char_spacing",
  textJustification: "text_justification",
  paragraphSpacing: "paragraph_spacing",
  firstLineIndent: "first_line_indent",
  readingMode: "reading_mode",
  pageColumns: "page_columns",
  margins: "margins",
  showLookupMarkers: "show_lookup_markers",
  showNewVocabMarkers: "show_new_vocab_markers",
  showLearningMarkers: "show_learning_markers",
  showMasteredMarkers: "show_mastered_markers",
} as const;

export type PerBookOverrideKey = keyof typeof perBookSettingKeys;
export type PerBookSettingRowKey = (typeof perBookSettingKeys)[PerBookOverrideKey];
export type PerBookReaderSettings = Record<string, string>;

export const perBookOverrideKeys = Object.keys(perBookSettingKeys) as PerBookOverrideKey[];

/**
 * The per-book keys 「设为全局默认」 can lift into the global `settings` table —
 * i.e. exactly those `reader_global_key()` in `commands/settings.rs` maps to a
 * global key. The two lists have to agree: the backend rejects a promotion of a
 * key it cannot map, and a key missing from here silently loses the button.
 *
 * The four marker toggles are here now that they have a global layer of their
 * own. Rows that are not reader settings at all (`toc_expanded`) still fall
 * outside, which is what `promotableRows` filters out.
 */
export const promotableBookSettingKeys: readonly PerBookSettingRowKey[] = [
  "theme",
  "font",
  "font_size",
  "line_spacing",
  "word_spacing",
  "char_spacing",
  "text_justification",
  "paragraph_spacing",
  "first_line_indent",
  "reading_mode",
  "page_columns",
  "margins",
  "show_lookup_markers",
  "show_new_vocab_markers",
  "show_learning_markers",
  "show_mastered_markers",
];

/** One `book_settings` row that a promotion deleted, as the backend returns it. */
export interface PromotedBookSetting {
  book_id: string;
  key: string;
  value: string;
}

/**
 * What one promotion displaced, held by the caller for as long as the undo
 * affordance is on screen and handed straight back to `undo_promote_book_settings`.
 *
 * A `null` in `globals` means that key had no row before the promotion, so the
 * undo deletes it rather than writing an empty string.
 */
export interface ReaderSettingsPromotionUndo {
  globals: Record<string, string | null>;
  book_settings: PromotedBookSetting[];
}

export function isPromotionUndoable(undo: ReaderSettingsPromotionUndo | null): boolean {
  if (!undo) return false;
  return Object.keys(undo.globals).length > 0 || undo.book_settings.length > 0;
}

/**
 * The one action the reader panel is still offering to take back. Both kinds
 * share a single slot on purpose: two live undo toasts would each claim to be
 * "the last thing you did", and taking the older one back would silently
 * re-apply rows the newer one had already moved.
 */
export type PendingReaderSettingsUndo =
  | { kind: "restore"; label: string; values: Record<string, string> }
  | { kind: "promote"; label: string; undo: ReaderSettingsPromotionUndo };

/**
 * Whether the pending undo would actually put something back. An affordance
 * that resolves to a no-op is worse than none: the user reads it as "this can
 * be reversed" and finds out otherwise only after committing to it.
 */
export function isPendingUndoActionable(pending: PendingReaderSettingsUndo | null): boolean {
  if (!pending) return false;
  return pending.kind === "restore"
    ? Object.keys(pending.values).length > 0
    : isPromotionUndoable(pending.undo);
}

/**
 * How many books *other than the one being read* a promotion moved, counted off
 * the undo payload rather than off the confirm view's selection.
 *
 * The two can disagree: the selection is what the user ticked, while the
 * payload is what the backend actually displaced — a selected book whose rows
 * had already gone is not in it. The source book is excluded because promoting
 * deletes its rows without changing a single value it renders; reporting it as
 * a book that "changed" would name a change the reader cannot see.
 */
export function promotionOtherBookCount(
  undo: ReaderSettingsPromotionUndo | null,
  sourceBookId?: string,
): number {
  if (!undo) return 0;
  const books = new Set<string>();
  for (const row of undo.book_settings) {
    if (row.book_id !== sourceBookId) books.add(row.book_id);
  }
  return books.size;
}

/**
 * The promote undo toast's label: what happened, and how far it reached.
 *
 * With no other book touched the reach clause is dropped rather than rendered
 * as "0 books" — a count of nothing is noise, and it reads as a failure.
 */
export function promotionToastLabel(
  undo: ReaderSettingsPromotionUndo | null,
  sourceBookId: string | undefined,
  t: (key: string, options?: { count: number }) => string,
): string {
  const promoted = t("readerSettings.scope.promoted");
  const count = promotionOtherBookCount(undo, sourceBookId);
  if (count === 0) return promoted;
  return `${promoted} · ${t("readerSettings.scope.promotedBooks", { count })}`;
}

export function overriddenStateKeys(rows: PerBookReaderSettings): PerBookOverrideKey[] {
  return perBookOverrideKeys.filter((key) => rows[perBookSettingKeys[key]] !== undefined);
}

export function promotableRows(rows: PerBookReaderSettings): PerBookSettingRowKey[] {
  return promotableBookSettingKeys.filter((key) => rows[key] !== undefined);
}

export function encodeReaderSetting(
  key: PerBookOverrideKey,
  state: ReaderSettingsState,
): string {
  return String(state[key]);
}

export interface ReaderSettingConflict {
  id: string;
  title: string;
  author: string;
  conflicting_keys: PerBookSettingRowKey[];
}

export function filterReaderSettingConflicts(
  conflicts: ReaderSettingConflict[],
  query: string,
): ReaderSettingConflict[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return conflicts;
  return conflicts.filter((conflict) => (
    `${conflict.title} ${conflict.author}`.toLocaleLowerCase().includes(normalized)
  ));
}

export function toggleVisibleConflictSelection(
  selected: ReadonlySet<string>,
  visible: ReaderSettingConflict[],
): Set<string> {
  const next = new Set(selected);
  const shouldSelect = visible.some((conflict) => !next.has(conflict.id));
  for (const conflict of visible) {
    if (shouldSelect) next.add(conflict.id);
    else next.delete(conflict.id);
  }
  return next;
}
