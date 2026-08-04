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
];

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
