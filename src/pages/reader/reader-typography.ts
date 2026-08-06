import type { ReaderSettingsState } from "../../components/ReaderSettings";

export const TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS = "lantern-typography-media";
export const TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS = "lantern-typography-no-indent";
export const TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS = "lantern-typography-drop-cap";
export const TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR = "--lantern-drop-cap-line-height";

// Embedded as a comment on the first line of every reader stylesheet (see
// `getReaderCSS` in reader-theme.ts) so `markTypographyDropCapParagraphs`
// below can find our own injected `<style>` tag among whatever `<style>`/
// `<link>` elements the publisher's own markup already put in `<head>`, and
// briefly blank it to read the section's un-overridden computed styles.
export const READER_STYLESHEET_MARKER = "/* lantern-reader-stylesheet */";

function normalizedTagName(element: Element): string {
  return (element.localName || element.tagName).toUpperCase();
}

/**
 * Safari 15.1 has no `:has()`, so mark media-bearing paragraphs before the
 * reader stylesheet is applied instead of relying on a parent selector.
 *
 * That comment describes the *intent*, not the actual wiring: by the time
 * this runs (on the `load` event), the reader stylesheet is already live.
 * Foliate's paginator writes the cached CSS text into the new section
 * document's `<style>` tag and only *then* dispatches `load` — see the
 * `onLoad` closure inside `#goTo` in `public/foliate-js/paginator.js`, which
 * calls `setStyles(this.#styles)` before `dispatchEvent(new CustomEvent
 * ('load', ...))`. That is true for the very first section too, since
 * `#index` starts at `-1`, so even the initial display goes through the same
 * `#goTo` branch. It does not matter for the class-based `:not()` exclusions
 * below — CSS selector matching is live against current DOM state, not a
 * snapshot taken when the stylesheet text was set, so adding a class after
 * the fact still works. It matters a great deal for
 * `markTypographyDropCapParagraphs`, which needs to read a computed style
 * the reader stylesheet has *not yet* touched — see its own comment.
 */
export function markTypographyMediaParagraphs(doc: Document): void {
  for (const paragraph of doc.querySelectorAll("p")) {
    paragraph.classList.toggle(
      TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS,
      paragraph.querySelector("img, svg, video, figure, object, embed") !== null,
    );
  }
}

const HEADING_OR_RULE_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "HR"]);

/**
 * Marks paragraphs that must never receive the first-line indent: the first
 * paragraph of the section body, and any paragraph immediately following a
 * heading or `<hr>`. Typographic convention never indents a paragraph that
 * opens a section or immediately follows a heading — there is no "new
 * paragraph" ambiguity for the indent to resolve, and forcing one anyway
 * wedges a gap between a publisher drop cap and the text that follows it.
 *
 * "Immediately following" means the paragraph's own previous element
 * sibling, not an ancestor search — the common EPUB shape is a heading and
 * its opening paragraph as direct siblings under the same container.
 */
export function markTypographyIndentExceptions(doc: Document): void {
  const paragraphs = doc.querySelectorAll("p");
  const firstParagraph: Element | undefined = paragraphs[0];
  for (const paragraph of paragraphs) {
    const previousSibling = paragraph.previousElementSibling;
    const noIndent = paragraph === firstParagraph
      || (previousSibling !== null && HEADING_OR_RULE_TAGS.has(normalizedTagName(previousSibling)));
    paragraph.classList.toggle(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS, noIndent);
  }
}

// A first letter that is floated is unambiguously a drop cap regardless of
// size. One that merely has a larger font-size (e.g. a slightly emphasized
// initial) needs a size ratio to avoid false positives — 1.4x is comfortably
// below typical drop-cap sizing (2.5-4em against a ~1em body) and above any
// ordinary emphasis styling.
const DROP_CAP_FONT_SIZE_RATIO = 1.4;

function parsePx(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pure so it is unit-testable without a DOM: does this first-letter geometry
 * — read with the reader's own stylesheet suppressed — look like a
 * publisher drop cap rather than an ordinary first letter?
 */
export function isDropCapFirstLetter(
  firstLetterFloat: string,
  firstLetterFontSizePx: number,
  paragraphFontSizePx: number,
): boolean {
  if (firstLetterFloat !== "none") return true;
  if (paragraphFontSizePx <= 0) return false;
  return firstLetterFontSizePx / paragraphFontSizePx >= DROP_CAP_FONT_SIZE_RATIO;
}

/**
 * Publisher drop caps are typically `p::first-letter { float: left;
 * font-size: 3.5em; line-height: 0.8 }`. `getReaderCSS` forces `line-height`
 * on `p`/`span`/`div`/... with `!important` for the user's line-spacing
 * setting; within the author origin `!important` beats specificity, so that
 * rule wins the cascade for the paragraph and for anything inheriting from
 * it — including a first-letter pseudo-box that relies on inheritance rather
 * than its own explicit rule. The oversized letter then gets a tall line box
 * and sinks below where the publisher placed it.
 *
 * This reads the *true* computed first-letter style — with our own
 * stylesheet briefly blanked out, so the read reflects only the publisher's
 * CSS and the UA default — and, for paragraphs that genuinely carry a drop
 * cap, pins the captured line-height back via a CSS custom property that
 * `getReaderCSS`'s own `!important` rule reads (see
 * `TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR` in reader-theme.ts). Capture-and-
 * restore, not a guessed constant: whatever geometry the publisher actually
 * used is what comes back. An ordinary first letter is left untouched and
 * keeps inheriting the user's line-spacing setting like the rest of the
 * paragraph.
 *
 * Must run after `markTypographyMediaParagraphs`/`markTypographyIndent
 * Exceptions` (order does not actually matter between those three) but
 * before anything else reads or relies on the reader stylesheet being
 * active, since it toggles that stylesheet off for the duration of the read.
 */
export function markTypographyDropCapParagraphs(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  const readerStyle = Array.from(doc.head?.querySelectorAll("style") ?? [])
    .find((style) => style.textContent?.includes(READER_STYLESHEET_MARKER)) ?? null;
  const restoreText = readerStyle?.textContent ?? null;
  if (readerStyle) readerStyle.textContent = "";
  try {
    for (const paragraph of doc.querySelectorAll("p")) {
      const firstLetter = view.getComputedStyle(paragraph, "::first-letter");
      const paragraphFontSizePx = parsePx(view.getComputedStyle(paragraph).fontSize);
      const isDropCap = isDropCapFirstLetter(
        firstLetter.cssFloat,
        parsePx(firstLetter.fontSize),
        paragraphFontSizePx,
      );
      paragraph.classList.toggle(TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS, isDropCap);
      if (isDropCap) {
        paragraph.style.setProperty(TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR, firstLetter.lineHeight);
      } else {
        paragraph.style.removeProperty(TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR);
      }
    }
  } finally {
    if (readerStyle) readerStyle.textContent = restoreText;
  }
}

export function getParagraphTypographyCSS(
  settings: Pick<ReaderSettingsState, "textJustification" | "paragraphSpacing" | "firstLineIndent">,
): string {
  const paragraphGap = settings.paragraphSpacing === "original" ? undefined : {
    none: "0",
    compact: "0.45em",
    comfortable: "0.85em",
    loose: "1.25em",
  }[settings.paragraphSpacing];
  if (!settings.textJustification && !paragraphGap && !settings.firstLineIndent) return "";
  const paragraphSelector = `p:not(
      blockquote p,
      pre p,
      center p,
      [align="center"] p,
      [style*="text-align: center" i] p,
      [style*="text-align:center" i] p,
      .center p,
      .title p,
      .heading p,
      figure p
    ):not([align="center"]):not([style*="text-align: center" i]):not([style*="text-align:center" i]):not(.center):not(.title):not(.heading):not(.${TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS})`;
  // Indent gets its own, narrower selector: the media/structural exclusions
  // above still apply, plus the paragraphs marked by
  // markTypographyIndentExceptions — but that extra exclusion is specific to
  // the indent rule. A paragraph that opens a chapter still gets justified
  // and spaced like any other; it just never gets the first-line indent.
  const indentSelector = `${paragraphSelector}:not(.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS})`;
  // Justification alone only redistributes a line's leftover space into word
  // gaps — it can only loosen. Hyphenation is a separate, much rarer
  // decision: per the user's own reading of how books actually behave,
  // breaking a word is only ever worth it when the alternative — pushing the
  // whole word to the next line — would leave a conspicuous gap, which only
  // happens for a genuinely long word caught just short of fitting. That is
  // a per-word judgement the browser already makes when it chooses between
  // "break it" and "push it down"; column width plays no part in that
  // choice, and CSS has no way to say "only when the leftover gap is under N
  // px" anyway. So hyphenation stays on whenever justify is on, and the
  // limit properties below do the real work: they only let hyphens/webkit
  // consider a word long enough that skipping it would look wrong, not any
  // word that merely overflows the line.
  const hyphenationCss = settings.textJustification ? `
        -webkit-hyphens: auto; hyphens: auto;
        /* The character minimum is the proxy for "the gap left behind would
           otherwise be conspicuous" (see the comment above) — it is not a
           readability knob, so do not lower it to hyphenate more eagerly.
           Both the -webkit- pair (Safari 5.1+) and the standard property
           (recent WebKit) are emitted, standard last, so an engine that only
           understands the prefixed pair still gets an equivalent ~9-char
           minimum (before + after) instead of silently hyphenating every
           word. */
        -webkit-hyphenate-limit-before: 5;
        -webkit-hyphenate-limit-after: 4;
        -webkit-hyphenate-limit-lines: 2;
        hyphenate-limit-chars: 10 5 4;
        hyphenate-limit-lines: 2;
      ` : "";
  return `
    /* Opt-in only: new books retain publisher paragraph styles by default. */
    ${paragraphSelector} {
      ${settings.textJustification ? "text-align: justify !important;" : ""}
      ${hyphenationCss}
      ${paragraphGap ? `margin-bottom: ${paragraphGap} !important;` : ""}
    }
    ${settings.firstLineIndent ? `
    ${indentSelector} {
      text-indent: 1.5em !important;
    }` : ""}
    :lang(zh) ${indentSelector}, ${indentSelector}:lang(zh),
    :lang(ja) ${indentSelector}, ${indentSelector}:lang(ja),
    :lang(ko) ${indentSelector}, ${indentSelector}:lang(ko) {
      ${settings.firstLineIndent ? "text-indent: 2em !important;" : ""}
    }
    :lang(zh) ${paragraphSelector}, ${paragraphSelector}:lang(zh),
    :lang(ja) ${paragraphSelector}, ${paragraphSelector}:lang(ja),
    :lang(ko) ${paragraphSelector}, ${paragraphSelector}:lang(ko) {
      ${settings.textJustification ? "-webkit-hyphens: manual; hyphens: manual;" : ""}
    }
  `;
}
