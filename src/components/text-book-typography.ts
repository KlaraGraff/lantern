import type { CSSProperties } from "react";
import type { ParagraphSpacing, ReaderSettingsState } from "./ReaderSettings";

/**
 * Pure paragraph-style calculation for the .txt reader, kept in step with
 * the EPUB reader's `getParagraphTypographyCSS`
 * (`src/pages/reader/reader-typography.ts`). The EPUB reader gets these
 * rules for free from the DOM (per-element `:lang()`, sibling selectors for
 * "follows a heading"); the .txt reader has no DOM to query, so the same
 * three decisions — CJK-or-not, first-paragraph-or-not, hyphenation bounds —
 * are made here as plain data in and data out, one paragraph at a time.
 */

// Same script ranges the EPUB reader's :lang(zh|ja|ko) selectors target:
// hiragana/katakana, the CJK unified ideograph block, and hangul syllables.
const CJK_TEXT_PATTERN = /[぀-ヿ㐀-鿿가-힯]/;

/**
 * Judge CJK-or-not per paragraph, not once for the whole book. A book that
 * mixes scripts (an English novel quoting Chinese poetry, a bilingual
 * reader) needs each paragraph indented and hyphenated by its own script,
 * not by whichever paragraph happened to load first.
 */
export function isCjkText(text: string): boolean {
  return CJK_TEXT_PATTERN.test(text);
}

const PARAGRAPH_GAP_BY_SPACING: Record<Exclude<ParagraphSpacing, "original">, string> = {
  none: "0",
  compact: "0.45em",
  comfortable: "0.85em",
  loose: "1.25em",
};

/**
 * Non-standard hyphenation properties that bound *where* a hyphenation
 * break may land, not *whether* one may happen at all (see the long comment
 * on `getParagraphTypographyCSS` for why the minimums exist). `csstype` —
 * and therefore `React.CSSProperties` — only knows the unprefixed
 * `hyphenateLimitChars`; the rest have no typed home in React's style
 * object, so they are carried as an explicit intersection instead of an
 * `any` cast.
 *
 * Typed `string`, not `number`, and that is load-bearing: React appends `px`
 * to any numeric style value outside its `unitlessNumbers` list, which carries
 * no `hyphenate*` entry. A bare `3` reaches the DOM as
 * `-webkit-hyphenate-limit-before: 3px`, which CSSOM drops on the floor —
 * leaving `hyphens: auto` running with no minimum at all. `string` makes that
 * mistake a compile error rather than a silently ignored declaration.
 */
interface HyphenationLimitProperties {
  WebkitHyphenateLimitBefore?: string;
  WebkitHyphenateLimitAfter?: string;
  WebkitHyphenateLimitLines?: string;
  hyphenateLimitLines?: string;
}

export type TextBookParagraphSettings = Pick<
  ReaderSettingsState,
  "textJustification" | "paragraphSpacing" | "firstLineIndent"
>;

export interface TextBookParagraphStyleOptions {
  /** This paragraph's own script, not the book's — see `isCjkText`. */
  isCjk: boolean;
  /**
   * True for the chapter-opening paragraph and any paragraph immediately
   * following a heading — typographic convention never indents either,
   * since there is no "new paragraph" ambiguity for the indent to resolve.
   * Does not affect justification or paragraph spacing, only the indent.
   */
  noIndent: boolean;
}

export function getTextBookParagraphStyle(
  settings: TextBookParagraphSettings,
  opts: TextBookParagraphStyleOptions,
): CSSProperties {
  const { isCjk, noIndent } = opts;
  // `original` means "keep the publisher's own margins" — but a .txt file has
  // no publisher and no stylesheet, so what actually stands is the reader's
  // default `mb-5`. Left alone, switching the indent on would give every
  // paragraph both a 20px gap and a 1.5em indent: the doubled-up "每段都被推开
  // 一次" look the exclusion in reader-paragraph-settings.ts exists to prevent.
  // The EPUB side needs no equivalent, because there `original` really does
  // defer to a publisher.
  const paragraphGap = settings.paragraphSpacing === "original"
    ? (settings.firstLineIndent ? "0" : undefined)
    : PARAGRAPH_GAP_BY_SPACING[settings.paragraphSpacing];

  const style: CSSProperties & HyphenationLimitProperties = {
    textAlign: settings.textJustification ? "justify" : undefined,
    // Justify-only, and for the reasons measured in `reader-typography.ts`:
    // it cuts the loosest line's word gap by ~21% in justified text and makes
    // ragged text visibly worse. The EPUB and plain-text readers must agree.
    textWrap: settings.textJustification ? "pretty" : undefined,
    marginBottom: paragraphGap,
    textIndent: settings.firstLineIndent && !noIndent ? (isCjk ? "2em" : "1.5em") : undefined,
  };

  // Justification alone only redistributes a line's leftover space into
  // word gaps; hyphenation is the separate, much rarer decision to break a
  // word rather than push it to the next line. It only ever turns on
  // alongside justification, matching the EPUB reader.
  if (settings.textJustification) {
    if (isCjk) {
      // CJK line-breaking never hyphenates a "word" — there are no spaces to
      // hyphenate between. Manual matches the EPUB reader's :lang(zh|ja|ko)
      // override.
      style.hyphens = "manual";
      style.WebkitHyphens = "manual";
    } else {
      style.hyphens = "auto";
      style.WebkitHyphens = "auto";
      // Character/line minimums keep hyphenation rare: a word is only ever
      // broken when skipping it would leave a conspicuously short line.
      style.WebkitHyphenateLimitBefore = "3";
      style.WebkitHyphenateLimitAfter = "3";
      style.WebkitHyphenateLimitLines = "2";
      style.hyphenateLimitChars = "6 3 3";
      style.hyphenateLimitLines = "2";
    }
  }

  return style;
}
