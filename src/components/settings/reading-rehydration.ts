/**
 * What Settings → Reading may re-read from the store, and what it must not.
 *
 * The generic rule lives in `settings-rehydration.ts`; this file is the Reading
 * pane's half of it — its groups, and the one extra thing that holds a group
 * back here.
 *
 * The extra thing is the number rows (font size, line spacing, character and
 * word spacing, margins). Their `<input type="number">` has no draft string of
 * its own: every keystroke lands straight in the pane's own state, and nothing
 * is written until the input blurs (Enter blurs it too). So while the user is
 * part-way through typing "16", the pane's `fontSize` *is* the half-typed
 * number — and re-reading that group would throw the digits away.
 *
 * A row is therefore held back only while both hold:
 *
 *  - its input has focus, and
 *  - its on-screen value is not the one the pane last read or wrote.
 *
 * Focus alone would block a row the user merely tabbed through; an unwritten
 * value alone would block for good if a write ever failed after the value had
 * moved. Together they describe exactly "digits on screen that nobody has
 * committed", and the block ends at the blur that commits them.
 *
 * One group per number row, so typing in font size cannot hold back a margin
 * change arriving from the reader window.
 */

import type { RehydrationGroup } from "./settings-rehydration";

/**
 * Each block of local state in the Reading pane, with the settings keys it is
 * built from — rows that are read and written together, and nothing wider.
 */
export const READING_REHYDRATION_GROUPS: readonly RehydrationGroup[] = [
  { id: "theme", keys: ["reader_theme", "reader_custom_theme"] },
  { id: "fontFamily", keys: ["font_family"] },
  { id: "fontSize", keys: ["font_size"] },
  { id: "narrowFontShrink", keys: ["narrow_font_shrink"] },
  { id: "lineSpacing", keys: ["line_spacing"] },
  { id: "charSpacing", keys: ["char_spacing"] },
  { id: "wordSpacing", keys: ["word_spacing"] },
  { id: "paragraph", keys: ["text_justification", "paragraph_spacing", "first_line_indent"] },
  { id: "margins", keys: ["margins"] },
  { id: "pageFlow", keys: ["reading_mode", "page_columns", "page_turn_animation"] },
  { id: "progress", keys: ["show_chapter_progress", "show_book_progress", "show_page_numbers"] },
  { id: "bindings", keys: ["previous_page_binding", "next_page_binding"] },
  { id: "autoSave", keys: ["auto_save"] },
  { id: "skipFrontMatter", keys: ["skip_front_matter"] },
  { id: "bookOpenCard", keys: ["book_open_card_enabled"] },
];

export const READING_REHYDRATION_KEYS = READING_REHYDRATION_GROUPS.flatMap(
  (group) => [...group.keys],
);

/** The typed-into rows, and the group each one would have to hold back. */
export const READING_NUMBER_ROWS: readonly { key: string; groupId: string }[] = [
  { key: "font_size", groupId: "fontSize" },
  { key: "line_spacing", groupId: "lineSpacing" },
  { key: "char_spacing", groupId: "charSpacing" },
  { key: "word_spacing", groupId: "wordSpacing" },
  { key: "margins", groupId: "margins" },
];

export interface NumberDraftInput {
  /** The settings key of the number input that has focus, if any. */
  focusedKey: string | null;
  /** Each number row's value as the pane would write it right now. */
  values: Record<string, string>;
  /** What the pane last read out of the settings map, or wrote into it. */
  applied: Record<string, string | undefined>;
}

/**
 * "1.80" and "1.8" are the same line spacing. The stored string comes from
 * whoever wrote it last — another window, an older build, the reader — and the
 * on-screen one from `String(Number(...))`, so comparing the text alone would
 * report a draft the user never typed.
 */
export function sameNumberValue(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = Number(a);
  const right = Number(b);
  if (a.trim() === "" || b.trim() === "") return false;
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * The groups holding digits the user has typed but not committed — at most one,
 * since only one input can have focus.
 */
export function groupsHoldingUncommittedNumber({
  focusedKey,
  values,
  applied,
}: NumberDraftInput): string[] {
  if (!focusedKey) return [];
  const row = READING_NUMBER_ROWS.find((candidate) => candidate.key === focusedKey);
  if (!row) return [];
  return sameNumberValue(values[row.key], applied[row.key]) ? [] : [row.groupId];
}
