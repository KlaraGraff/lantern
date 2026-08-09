import type { ReaderSettingsState } from "../../components/ReaderSettings";

export const TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS = "lantern-typography-media";
export const TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS = "lantern-typography-no-indent";
/**
 * Content inside a quote, a preformatted block or a figure: not body prose,
 * and never given body-prose treatment whatever it computes to. Stamped in JS
 * for the same Safari 15 reason as `NEVER_INDENT_SELECTOR` — see the comment
 * on `markTypographyIndentExceptions`.
 */
export const TYPOGRAPHY_STRUCTURAL_CLASS = "lantern-typography-structural";
export const TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS = "lantern-typography-drop-cap";
export const TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR = "--lantern-drop-cap-line-height";
// A <div> that holds nothing but inline content is a paragraph in everything
// but tag name — a very common EPUB shape. Marked from JS rather than matched
// with `div:not(:has(*:not(<inline list>)))` because `:has()` needs Safari
// 15.4 and the reader's compatibility floor is Safari 15 (`SAFARI_15_TARGET`
// in scripts/build-reader-assets.mjs).
export const TYPOGRAPHY_INLINE_DIV_CLASS = "lantern-typography-inline-div";
// The publisher deliberately centred/right-aligned this block, or gave it a
// hanging (negative) indent. Both are read from the *computed* style with our
// own stylesheet suppressed — see `stampPublisherTypography`.
export const TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS = "lantern-typography-publisher-aligned";
export const TYPOGRAPHY_HANGING_INDENT_CLASS = "lantern-typography-hanging-indent";
/**
 * A block with no text of its own. Publishers use one as a scene break — an
 * empty `<p>` whose entire job is the vertical space its margin makes. Setting
 * the paragraph gap (including to `0`) would collapse it to nothing and take
 * the scene break with it, so blank blocks keep whatever margin the publisher
 * gave them. Blocks holding only an image are already spared by
 * `TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS`.
 *
 * Matched in JS: `:empty` does not match `<p> </p>` or `<p><br/></p>`, which
 * is most of what this shape looks like in the wild.
 */
export const TYPOGRAPHY_BLANK_BLOCK_CLASS = "lantern-typography-blank";

// Embedded as a comment on the first line of every reader stylesheet (see
// `getReaderCSS` in reader-theme.ts) so `stampPublisherTypography` below can
// find our own injected `<style>` tag among whatever `<style>`/`<link>`
// elements the publisher's own markup already put in `<head>`, and briefly
// blank it to read the section's un-overridden computed styles.
export const READER_STYLESHEET_MARKER = "/* lantern-reader-stylesheet */";

// Every block we are willing to treat as a paragraph. `div` is here as a bare
// tag because the "does this div hold only inline content?" test happens in
// JS; the emitted CSS only ever targets `div.<TYPOGRAPHY_INLINE_DIV_CLASS>`.
export const TYPOGRAPHY_CANDIDATE_SELECTOR = "p, div, li, dd, blockquote";

// Phrasing content plus the replaced elements publishers routinely drop into
// an otherwise-textual div. Anything outside this list makes the div a
// container rather than a paragraph.
const INLINE_CONTENT_TAGS = [
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i", "kbd",
  "mark", "q", "ruby", "rt", "rp", "s", "samp", "small", "span", "strong", "sub", "sup",
  "time", "u", "var", "wbr", "img", "image", "svg",
];

// `querySelector` stops at the first match, so this is the cheap equivalent of
// the `:has(*:not(...))` test — and, like it, looks at every descendant, not
// just the direct children.
const NON_INLINE_DESCENDANT_SELECTOR = `*:not(${INLINE_CONTENT_TAGS.join(", ")})`;

function normalizedTagName(element: Element): string {
  return (element.localName || element.tagName).toUpperCase();
}

function isInlineOnlyDiv(element: Element): boolean {
  return element.querySelector(NON_INLINE_DESCENDANT_SELECTOR) === null;
}

/**
 * Is this one of the blocks the typography rules may restyle? Every candidate
 * tag qualifies outright except `div`, which has to prove it holds only inline
 * content first.
 */
export function isTypographyParagraph(element: Element): boolean {
  const tag = normalizedTagName(element);
  if (tag === "DIV") return isInlineOnlyDiv(element);
  return tag === "P" || tag === "LI" || tag === "DD" || tag === "BLOCKQUOTE";
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
 * `stampPublisherTypography`, which needs to read computed styles the reader
 * stylesheet has *not yet* touched — see its own comment.
 */
export function markTypographyMediaParagraphs(doc: Document): void {
  for (const paragraph of doc.querySelectorAll(TYPOGRAPHY_CANDIDATE_SELECTOR)) {
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
 *
 * "First paragraph" means the first *eligible* candidate in document order,
 * not the first candidate outright: a wrapping `<div>` precedes the `<p>` it
 * contains in document order but is not itself a paragraph, and claiming the
 * exception for it would leave the real opening paragraph indented.
 *
 * The same class also carries the *shape* exceptions — list, definition,
 * table and quoted content, plus the two opt-out class names publishers
 * conventionally use. Those are matched here, in JS, rather than written as
 * `:not(li p, blockquote *, …)` in the stylesheet, and that is deliberate:
 * a complex selector inside `:not()` is a Selectors-4 feature this project's
 * Safari 15 floor does not have, and an unsupported argument invalidates the
 * *entire* selector rather than just that clause — which would drop the whole
 * indent rule on the oldest platform we support, silently. `querySelectorAll`
 * has no such limit, so the matching happens here and the stylesheet is left
 * with nothing but single class names to exclude.
 *
 * The same pass also stamps `TYPOGRAPHY_STRUCTURAL_CLASS` and
 * `TYPOGRAPHY_BLANK_BLOCK_CLASS`, which are about the paragraph gap rather than
 * the indent — they ride along because this is the one walk over every
 * candidate block in the section.
 */
const NEVER_INDENT_SELECTOR = [
  // Their own container already carries the horizontal offset, so an indent
  // on top of it reads as a misalignment.
  "li", "dd", "li p", "ol p", "ul p", "dd p", "td p",
  // Quoted matter is not body prose and takes no body-prose treatment. The
  // container and its contents both, since `text-indent` inherits.
  "blockquote", "blockquote *",
  ".noindent", ".nonindent",
].join(", ");

export function markTypographyIndentExceptions(doc: Document): void {
  const paragraphs = doc.querySelectorAll(TYPOGRAPHY_CANDIDATE_SELECTOR);
  let firstParagraph: Element | undefined;
  for (const paragraph of paragraphs) {
    if (isTypographyParagraph(paragraph)) {
      firstParagraph = paragraph;
      break;
    }
  }
  for (const element of doc.querySelectorAll("blockquote *, pre *, figure *")) {
    element.classList.add(TYPOGRAPHY_STRUCTURAL_CLASS);
  }
  const neverIndent = new Set(doc.querySelectorAll(NEVER_INDENT_SELECTOR));
  for (const paragraph of paragraphs) {
    const previousSibling = paragraph.previousElementSibling;
    const noIndent = paragraph === firstParagraph
      || neverIndent.has(paragraph)
      || (previousSibling !== null && HEADING_OR_RULE_TAGS.has(normalizedTagName(previousSibling)));
    paragraph.classList.toggle(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS, noIndent);
    paragraph.classList.toggle(
      TYPOGRAPHY_BLANK_BLOCK_CLASS,
      (paragraph.textContent ?? "").trim().length === 0,
    );
  }
  // Containers that are themselves never paragraph candidates still have to
  // be reset, because a `<p>` inside them would otherwise inherit their
  // indent — inheritance does not care that the container was skipped.
  for (const element of neverIndent) {
    element.classList.add(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS);
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
 * Pure so it is unit-testable without a DOM: `start`/`left`/`justify` mean the
 * publisher expressed no opinion we need to respect, anything else does.
 * `end` is the logical spelling of `right` and appears in computed styles on
 * engines that keep the logical keyword.
 */
export function isPublisherAlignedValue(textAlign: string): boolean {
  return textAlign === "center" || textAlign === "right" || textAlign === "end";
}

interface PublisherTypographyRead {
  element: HTMLElement;
  inlineDiv: boolean;
  publisherAligned: boolean;
  hangingIndent: boolean;
  dropCap: boolean;
  dropCapLineHeight: string;
}

/**
 * Reads the publisher's *own* typography off every paragraph candidate — with
 * our stylesheet briefly blanked, so what comes back is the publisher's CSS
 * plus the UA default and nothing of ours — and stamps four marker classes
 * the emitted rules key off:
 *
 * - `TYPOGRAPHY_INLINE_DIV_CLASS`: a `<div>` holding only inline content, i.e.
 *   a paragraph in everything but tag name.
 * - `TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS`: computed `text-align` is centred or
 *   right/end-aligned. This replaced a `:not(.center):not(.title):not([style*=
 *   "text-align: center"])`-style guess list, which could only ever catch the
 *   rarest spelling (an inline `style` attribute) and silently justified every
 *   block a publisher centred from a class or an external stylesheet.
 * - `TYPOGRAPHY_HANGING_INDENT_CLASS`: computed `text-indent` is negative, so
 *   the publisher built a hanging indent (verse, indices, dialogue lists).
 *   Justification still applies; our first-line indent must not.
 * - `TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS` (+ the captured line-height):
 *   publisher drop caps are typically `p::first-letter { float: left;
 *   font-size: 3.5em; line-height: 0.8 }`. `getReaderCSS` forces `line-height`
 *   with `!important` for the user's line-spacing setting; within the author
 *   origin `!important` beats specificity, so that rule wins for the paragraph
 *   and for anything inheriting from it — including a first-letter pseudo-box
 *   that has no explicit rule of its own. The oversized letter then gets a
 *   tall line box and sinks below where the publisher placed it. Capture-and-
 *   restore, not a guessed constant: whatever geometry the publisher actually
 *   used is pinned back through a custom property that `getReaderCSS`'s own
 *   `!important` rule reads.
 *
 * **Strictly two passes, and it must stay that way.** Every
 * `getComputedStyle` read happens in the first loop and lands in an array;
 * only the second loop touches `classList`/`style`. Interleaving them makes
 * each read invalidate the style the previous write dirtied, so every
 * iteration forces a whole-document style recalculation — the shape that
 * Readest measured at 1210ms of forced reflow on Android for a single
 * section. Two passes cost exactly one.
 *
 * Must run after `markTypographyMediaParagraphs`/`markTypographyIndent
 * Exceptions` (order does not actually matter between those three) but
 * before anything else reads or relies on the reader stylesheet being
 * active, since it toggles that stylesheet off for the duration of the read.
 */
export function stampPublisherTypography(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  const readerStyle = Array.from(doc.head?.querySelectorAll("style") ?? [])
    .find((style) => style.textContent?.includes(READER_STYLESHEET_MARKER)) ?? null;
  const restoreText = readerStyle?.textContent ?? null;
  if (readerStyle) readerStyle.textContent = "";
  const reads: PublisherTypographyRead[] = [];
  try {
    // Pass 1 — read only. `querySelector`/`localName` are DOM-tree lookups,
    // not layout reads, so the inline-div test is free to sit here.
    for (const element of doc.querySelectorAll<HTMLElement>(TYPOGRAPHY_CANDIDATE_SELECTOR)) {
      const isDiv = normalizedTagName(element) === "DIV";
      const inlineDiv = isDiv && isInlineOnlyDiv(element);
      if (isDiv && !inlineDiv) {
        // A container div is not a paragraph; skip the computed-style read
        // entirely, but still record it so the write pass can clear any
        // marker a previous section state left behind.
        reads.push({
          element,
          inlineDiv: false,
          publisherAligned: false,
          hangingIndent: false,
          dropCap: false,
          dropCapLineHeight: "",
        });
        continue;
      }
      const paragraphStyle = view.getComputedStyle(element);
      const firstLetter = view.getComputedStyle(element, "::first-letter");
      reads.push({
        element,
        inlineDiv,
        publisherAligned: isPublisherAlignedValue(paragraphStyle.textAlign),
        hangingIndent: parsePx(paragraphStyle.textIndent) < 0,
        dropCap: isDropCapFirstLetter(
          firstLetter.cssFloat,
          parsePx(firstLetter.fontSize),
          parsePx(paragraphStyle.fontSize),
        ),
        dropCapLineHeight: firstLetter.lineHeight,
      });
    }
    // Pass 2 — write only.
    for (const read of reads) {
      const { element } = read;
      element.classList.toggle(TYPOGRAPHY_INLINE_DIV_CLASS, read.inlineDiv);
      element.classList.toggle(TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS, read.publisherAligned);
      element.classList.toggle(TYPOGRAPHY_HANGING_INDENT_CLASS, read.hangingIndent);
      element.classList.toggle(TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS, read.dropCap);
      if (read.dropCap) {
        element.style.setProperty(TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR, read.dropCapLineHeight);
      } else {
        element.style.removeProperty(TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR);
      }
    }
  } finally {
    if (readerStyle) readerStyle.textContent = restoreText;
  }
}

const CJK_LANGS = ["zh", "ja", "ko"];

// The blocks the rules target. `div` only ever appears class-qualified — see
// TYPOGRAPHY_INLINE_DIV_CLASS.
const PARAGRAPH_BASE_SELECTORS = [
  "p",
  `div.${TYPOGRAPHY_INLINE_DIV_CLASS}`,
  "li",
  "dd",
  "blockquote",
];

// Both exclusion sets are stamped as classes by markTypographyIndentExceptions
// rather than written out as selectors here — see the comment on that function
// for why the stylesheet must stay free of complex `:not()` arguments.

function withLangs(selectors: string[]): string {
  return CJK_LANGS
    .flatMap((lang) => selectors.flatMap((selector) => [
      `:lang(${lang}) ${selector}`,
      `${selector}:lang(${lang})`,
    ]))
    .join(",\n    ");
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
  // Centred/right-aligned blocks are excluded by the marker class stamped from
  // the publisher's own computed style, not by guessing at class names.
  const paragraphSuffix = `:not(.${TYPOGRAPHY_STRUCTURAL_CLASS})`
    + `:not(.${TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS}):not(.${TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS})`;
  const paragraphSelectors = PARAGRAPH_BASE_SELECTORS.map((base) => `${base}${paragraphSuffix}`);
  const paragraphSelector = paragraphSelectors.join(",\n    ");
  // The gap rule is narrower than the alignment rule. A `<blockquote>` is a
  // block of quoted matter, not a paragraph in the body rhythm — it justifies
  // like one but its own margins separate the quote from the prose around it,
  // and rewriting them makes the quote run into the next sentence. Blank
  // blocks are the publisher's scene breaks; see TYPOGRAPHY_BLANK_BLOCK_CLASS.
  const gapSelector = PARAGRAPH_BASE_SELECTORS
    .filter((base) => base !== "blockquote")
    .map((base) => `${base}${paragraphSuffix}:not(.${TYPOGRAPHY_BLANK_BLOCK_CLASS})`)
    .join(",\n    ");
  // Indent gets its own, narrower selector: the media/structural/alignment
  // exclusions above still apply, plus the paragraphs marked by
  // markTypographyIndentExceptions, the publisher's own hanging indents, and
  // the list/table/opt-out shapes. A paragraph that opens a chapter still gets
  // justified and spaced like any other; it just never gets the first-line
  // indent.
  const indentSelectors = paragraphSelectors.map((selector) =>
    `${selector}:not(.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS})`
    + `:not(.${TYPOGRAPHY_HANGING_INDENT_CLASS})`);
  const indentSelector = indentSelectors.join(",\n    ");
  // `text-indent` is inherited, so excluding a block from the indent rule is
  // not the same as it having no indent: a `<p>` inside an indented `<li>`
  // would inherit the container's 1.5em. Everything carrying the no-indent
  // class — containers included — is therefore reset outright.
  const indentResetSelector = `.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS}`;
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
           readability knob, so it is not a dial to turn for prettier prose.
           Six characters total (3 before the break + 3 after) is the floor at
           which the hole a skipped word leaves behind is ugly enough to be
           worth breaking: shorter words fit almost anywhere, so pushing them
           down costs nothing. The previous 10/5/4 floor was set so high that
           in practice nothing ever hyphenated at all.
           Both the -webkit- pair (Safari 5.1+) and the standard property
           (recent WebKit) are emitted, standard last, so an engine that only
           understands the prefixed pair still gets the same 6-char minimum
           (before + after) instead of silently hyphenating every word. */
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 3;
        -webkit-hyphenate-limit-lines: 2;
        hyphenate-limit-chars: 6 3 3;
        hyphenate-limit-lines: 2;
      ` : "";
  return `
    /* Opt-in only: new books retain publisher paragraph styles by default. */
    ${paragraphSelector} {
      ${settings.textJustification ? "text-align: justify !important;" : ""}
      ${hyphenationCss}
    }
    ${paragraphGap ? `
    ${gapSelector} {
      margin-bottom: ${paragraphGap} !important;
    }` : ""}
    ${settings.firstLineIndent ? `
    ${indentSelector} {
      text-indent: 1.5em !important;
    }
    ${indentResetSelector} {
      text-indent: 0 !important;
    }` : ""}
    ${withLangs(indentSelectors)} {
      ${settings.firstLineIndent ? "text-indent: 2em !important;" : ""}
    }
    ${withLangs(paragraphSelectors)} {
      ${settings.textJustification ? "-webkit-hyphens: manual; hyphens: manual;" : ""}
    }
  `;
}
