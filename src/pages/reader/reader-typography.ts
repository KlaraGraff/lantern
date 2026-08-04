import type { ReaderSettingsState } from "../../components/ReaderSettings";

export const TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS = "lantern-typography-media";

/**
 * Safari 15.1 has no `:has()`, so mark media-bearing paragraphs before the
 * reader stylesheet is applied instead of relying on a parent selector.
 */
export function markTypographyMediaParagraphs(doc: Document): void {
  for (const paragraph of doc.querySelectorAll("p")) {
    paragraph.classList.toggle(
      TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS,
      paragraph.querySelector("img, svg, video, figure, object, embed") !== null,
    );
  }
}

export function getParagraphTypographyCSS(settings: Pick<ReaderSettingsState,
  "textJustification" | "paragraphSpacing" | "firstLineIndent"
>): string {
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
  return `
    /* Opt-in only: new books retain publisher paragraph styles by default. */
    ${paragraphSelector} {
      ${settings.textJustification ? "text-align: justify !important;" : ""}
      ${settings.textJustification ? "-webkit-hyphens: auto; hyphens: auto;" : ""}
      ${paragraphGap ? `margin-bottom: ${paragraphGap} !important;` : ""}
      ${settings.firstLineIndent ? "text-indent: 1.5em !important;" : ""}
    }
    :lang(zh) ${paragraphSelector}, ${paragraphSelector}:lang(zh),
    :lang(ja) ${paragraphSelector}, ${paragraphSelector}:lang(ja),
    :lang(ko) ${paragraphSelector}, ${paragraphSelector}:lang(ko) {
      ${settings.firstLineIndent ? "text-indent: 2em !important;" : ""}
      ${settings.textJustification ? "-webkit-hyphens: manual; hyphens: manual;" : ""}
    }
  `;
}
