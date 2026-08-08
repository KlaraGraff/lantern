// What 「恢复默认」 in Settings → Reading actually writes.
//
// Deliberately derived from `createDefaultReaderSettings()` — the same function
// the reader seeds its own state from — rather than a second table of default
// values written out by hand here. A hand-written copy is a copy: the day
// someone changes the default font size in one place, the "restore defaults"
// button quietly starts restoring the *old* default, and nothing fails loudly.
//
// Pure on purpose (a plain state-in, rows-out mapping) so the unit test can
// pin the exact key set without a DOM.

import type { ReaderSettingsState } from "../ReaderSettings";

/**
 * Every global `settings` row the Reading section owns, in the order the rows
 * appear on screen.
 *
 * Not here, and not touched by the reset — each for its own reason:
 *  - `book_settings` rows (a book's own font size, margins, reading mode,
 *    marker toggles). Those are per-book overrides the user set deliberately
 *    inside a book; the reader panel has its own restore for them.
 *  - vocabulary-assist settings, which live on their own sub-page.
 *  - imported custom fonts and enhanced-font packages: files on disk, not
 *    preferences. Resetting `font_family` away from a custom font leaves the
 *    font itself installed and re-selectable.
 */
export const READING_DEFAULT_SETTING_KEYS = [
  "reader_theme",
  "reader_custom_theme",
  "font_family",
  "font_size",
  "narrow_font_shrink",
  "line_spacing",
  "char_spacing",
  "word_spacing",
  "text_justification",
  "paragraph_spacing",
  "first_line_indent",
  "margins",
  "reading_mode",
  "page_columns",
  "page_turn_animation",
  "show_chapter_progress",
  "show_book_progress",
  "show_page_numbers",
  "previous_page_binding",
  "next_page_binding",
  "auto_save",
  "skip_front_matter",
  "book_open_card_enabled",
] as const;

export type ReadingDefaultSettingKey = (typeof READING_DEFAULT_SETTING_KEYS)[number];

/**
 * The reader's default state as `settings` table rows — everything stringified,
 * because that table stores strings.
 */
export function buildReadingDefaultSettings(
  defaults: ReaderSettingsState,
): Record<ReadingDefaultSettingKey, string> {
  return {
    reader_theme: defaults.theme,
    reader_custom_theme: JSON.stringify(defaults.customTheme),
    font_family: defaults.font,
    font_size: String(defaults.fontSize),
    narrow_font_shrink: String(defaults.narrowFontShrink),
    line_spacing: String(defaults.lineSpacing),
    char_spacing: String(defaults.charSpacing),
    word_spacing: String(defaults.wordSpacing),
    text_justification: String(defaults.textJustification),
    paragraph_spacing: defaults.paragraphSpacing,
    first_line_indent: String(defaults.firstLineIndent),
    margins: String(defaults.margins),
    reading_mode: defaults.readingMode,
    page_columns: String(defaults.pageColumns),
    page_turn_animation: defaults.pageTurnAnimation,
    show_chapter_progress: String(defaults.showChapterProgress),
    show_book_progress: String(defaults.showBookProgress),
    show_page_numbers: String(defaults.showPageNumbers),
    previous_page_binding: defaults.previousPageBinding,
    next_page_binding: defaults.nextPageBinding,
    // Not part of `ReaderSettingsState` — these two moved in from 通用 as
    // app-level behavior toggles, not per-book reader state, so there is no
    // `createDefaultReaderSettings()` field to read them from. Their default
    // has always simply been on; that is what the reset restores them to.
    auto_save: "true",
    skip_front_matter: "true",
    // A third app-level behavior toggle that rode in on the same pane, for
    // the same reason as the two above — "restore defaults" should turn the
    // open card back on, since it lives on this screen next to the other two.
    book_open_card_enabled: "true",
  };
}
