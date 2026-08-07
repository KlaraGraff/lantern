import type { CSSProperties } from "react";
import type { ReaderSettingsState } from "../../components/ReaderSettings";
import {
  type ReaderCustomTheme,
  type ReaderMeasure,
  getEffectivePageColumns,
  getFontFamily,
  getReaderMeasure,
  getThemeStyles,
} from "../../components/reader-settings";
import { prefersReducedMotion } from "../../components/page-turn-transition";
import {
  READER_STYLESHEET_MARKER,
  TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR,
  TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS,
  getParagraphTypographyCSS,
} from "./reader-typography";

interface LayoutView {
  renderer: {
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    toggleAttribute(name: string, force?: boolean): boolean;
    render?(): void;
  };
}

export type PdfOverlay = { layers: CSSProperties[] } | null;

function readerSelectionColor(theme: string): string {
  switch (theme) {
    case "paper": return "rgba(163, 106, 49, 0.28)";
    case "quiet": return "rgba(216, 180, 254, 0.34)";
    case "dark": return "rgba(167, 139, 250, 0.38)";
    default: return "rgba(124, 58, 237, 0.24)";
  }
}

// Book content forces its own text color (see getReaderCSS), but links —
// footnote numbers above all — are <a> elements the publisher typically
// colors black or navy. Without an override they vanish against the two
// dark papers, so every theme pins a link color that survives its body.
function readerLinkColor(theme: string): string {
  switch (theme) {
    case "paper": return "#8A5728";
    case "quiet": return "#C4B5FD";
    case "dark": return "#A78BFA";
    default: return "#6D28D9";
  }
}

export function getPdfOverlays(theme: string, customTheme?: ReaderCustomTheme): PdfOverlay {
  switch (theme) {
    case "paper": return { layers: [{
      backgroundColor: getThemeStyles("paper").body,
      mixBlendMode: "multiply",
    }] };
    case "quiet": return { layers: [
      { backgroundColor: "#ffffff", mixBlendMode: "difference" },
      { backgroundColor: getThemeStyles("quiet").body, mixBlendMode: "screen" },
    ] };
    case "dark": return { layers: [
      { backgroundColor: "#ffffff", mixBlendMode: "difference" },
      { backgroundColor: getThemeStyles("dark").body, mixBlendMode: "screen" },
    ] };
    case "custom": return { layers: [{
      backgroundColor: getThemeStyles("custom", customTheme).body,
      mixBlendMode: "multiply",
    }] };
    default: return null;
  }
}

export function getReaderThemeVars(theme: string, customTheme?: ReaderCustomTheme): Record<string, string> | undefined {
  switch (theme) {
    case "original": return {
      "--color-bg-page": "#f4f4f5",
      "--color-bg-surface": "#ffffff",
      "--color-bg-muted": "#fafafa",
      "--color-bg-input": "#f3f3f5",
      "--color-text-primary": "#18181b",
      "--color-text-body": "#0a0a0a",
      "--color-text-secondary": "#52525c",
      "--color-text-muted": "#71717b",
      "--color-text-placeholder": "#a1a1aa",
      "--color-border": "#e4e4e7",
      "--color-border-light": "#f4f4f5",
      "--color-accent": "#7c3aed",
      "--color-accent-text": "#7c3aed",
      "--color-accent-bg": "#f3e8ff",
    };
    case "paper": return {
      "--color-bg-page": "#EBE1CB",
      "--color-bg-surface": "#F2E9D8",
      "--color-bg-muted": "#EFE5D2",
      "--color-bg-input": "#E8DDC6",
      "--color-text-primary": "#3B3325",
      "--color-text-body": "#3B3325",
      "--color-text-secondary": "#6B5F4B",
      "--color-text-muted": "#8A7C63",
      "--color-text-placeholder": "#A2947A",
      "--color-border": "#D8CCB2",
      "--color-border-light": "#E7DEC9",
      "--color-accent": "#A36A31",
      "--color-accent-text": "#8A5728",
      "--color-accent-bg": "#EEDFC5",
    };
    case "quiet": return {
      "--color-bg-page": "#3C3C43",
      "--color-bg-surface": "#45454C",
      "--color-bg-muted": "#4C4C54",
      "--color-bg-input": "#55555E",
      "--color-text-primary": "#E7E7EC",
      "--color-text-body": "#D9D9DE",
      "--color-text-secondary": "#B9B9C2",
      "--color-text-muted": "#9A9AA4",
      "--color-text-placeholder": "#82828C",
      "--color-border": "#62626C",
      "--color-border-light": "#52525A",
      "--color-accent": "#A78BFA",
      "--color-accent-text": "#C4B5FD",
      "--color-accent-bg": "#4A4160",
    };
    case "dark": return {
      "--color-bg-page": "#0E0E11",
      "--color-bg-surface": "#121216",
      "--color-bg-muted": "#1A1A1F",
      "--color-bg-input": "#222228",
      "--color-text-primary": "#EDEDF0",
      "--color-text-body": "#C9C9D1",
      "--color-text-secondary": "#B4B4BD",
      "--color-text-muted": "#8E8E98",
      "--color-text-placeholder": "#787882",
      "--color-border": "#2E2E37",
      "--color-border-light": "#25252C",
      "--color-accent": "#8B5CF6",
      "--color-accent-text": "#A78BFA",
      "--color-accent-bg": "#2B2342",
    };
    case "custom": {
      const colors = getThemeStyles("custom", customTheme);
      return {
        "--color-bg-page": colors.body,
        "--color-bg-surface": colors.body,
        "--color-bg-muted": colors.body,
        "--color-bg-input": `${colors.text}12`,
        "--color-text-primary": colors.text,
        "--color-text-body": colors.text,
        "--color-text-secondary": `${colors.text}CC`,
        "--color-text-muted": `${colors.text}A6`,
        "--color-text-placeholder": `${colors.text}80`,
        "--color-border": `${colors.text}30`,
        "--color-border-light": `${colors.text}1A`,
        "--color-accent": "#7C3AED",
        "--color-accent-text": "#6D28D9",
        "--color-accent-bg": `${colors.text}12`,
      };
    }
    default: return undefined;
  }
}

// `fontSize` is passed separately because the rendered size can be smaller than
// the stored one on a narrow viewport (see getReaderMeasure). Callers that know
// the viewport pass the resolved size; the rest fall back to the stored one.
export function getReaderCSS(
  settings: ReaderSettingsState,
  fontSize: number = settings.fontSize,
): string {
  const themeColors = getThemeStyles(settings.theme, settings.customTheme);
  const fontFamily = getFontFamily(settings.font);
  const letterSpacing = settings.charSpacing === 0 ? "normal" : `${settings.charSpacing * 0.01}em`;
  const wordSpacing = settings.wordSpacing === 0 ? "normal" : `${settings.wordSpacing * 0.01}em`;
  const paragraphTypographyCss = getParagraphTypographyCSS(settings);
  const chapterBreakCss = settings.readingMode === "paginated" ? `
    [data-lantern-chapter-start] {
      break-before: column !important;
      page-break-before: always !important;
    }
  ` : "";
  return `
    ${READER_STYLESHEET_MARKER}
    body {
      background-color: ${themeColors.body} !important;
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      font-size: ${fontSize}px !important;
      line-height: ${settings.lineSpacing} !important;
      letter-spacing: ${letterSpacing} !important;
      word-spacing: ${wordSpacing} !important;
      text-wrap: pretty;
    }
    p, span, div, li, td, th, h1, h2, h3, h4, h5, h6 {
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      line-height: ${settings.lineSpacing} !important;
    }
    /* Publisher drop caps (marked by markTypographyDropCapParagraphs, which
       captures the true value before this stylesheet is live) keep their
       original first-letter line-height instead of the forced one above —
       an oversized floated letter needs a tight line-height to sit level
       with the text beside it, not the user's prose line-spacing. */
    .${TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS}::first-letter {
      line-height: var(${TYPOGRAPHY_DROP_CAP_LINE_HEIGHT_VAR}) !important;
    }
    /* Headings read better balanced and should never be hyphenated. */
    h1, h2, h3, h4, h5, h6 {
      text-wrap: balance;
      -webkit-hyphens: none;
      hyphens: none;
    }
    /* Code and preformatted text must not be hyphenated. */
    pre, code, kbd, samp, tt {
      -webkit-hyphens: none;
      hyphens: none;
    }
    a, a span {
      color: ${readerLinkColor(settings.theme)} !important;
    }
    ::selection {
      background: ${readerSelectionColor(settings.theme)} !important;
      color: inherit !important;
    }
    ${chapterBreakCss}
    ${paragraphTypographyCss}
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${themeColors.text}33; border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: ${themeColors.text}55; }
    img, svg, video {
      max-width: 100% !important;
      height: auto !important;
      object-fit: contain !important;
      box-sizing: border-box !important;
    }
    figure {
      max-width: 100% !important;
      overflow: hidden !important;
    }
    ${settings.theme === "dark" || settings.theme === "quiet" ? `
    /* Illustrations keep their white page background; at full brightness they
       glare against a dark paper, so night themes dim them slightly — the same
       treatment Apple Books and Kindle give images in their night modes. */
    img, svg, video {
      filter: brightness(0.85);
    }
    ` : ""}
  `;
}

// Styles for the footnote popover's nested foliate-view. It has no font-size
// control of its own, so this fixes a compact size/line-height instead of
// following `getReaderCSS`'s reader-configured ones.
export function getFootnoteCSS(settings: ReaderSettingsState): string {
  const themeColors = getThemeStyles(settings.theme, settings.customTheme);
  const fontFamily = getFontFamily(settings.font);
  return `
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      background: transparent !important;
    }
    body {
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      font-size: 13.5px !important;
      line-height: 1.6 !important;
    }
    a { color: ${themeColors.text}; }
    img, svg, video {
      max-width: 100% !important;
      height: auto !important;
    }
  `;
}

export function applyReflowLayout(
  view: LayoutView,
  settings: ReaderSettingsState,
  viewportWidth: number,
  viewportHeight: number,
): ReaderMeasure {
  const isPaginated = settings.readingMode === "paginated";
  const measure = getReaderMeasure(settings, viewportWidth, viewportHeight);
  const effectiveColumns = measure.columns;
  // Foliate lays the page out on a grid whose content track is
  // `max-inline-size * columns - gap`, flanked by `gap`-derived margin tracks
  // (see the #top grid-template in foliate-js/paginator.js). Sizing a column to
  // the full viewport share leaves no room for those margins: the grid's
  // minimum tracks then exceed the viewport, the content track gets squeezed by
  // an extra gap, and the visible margin drifts off the configured percentage.
  // Worse, the squeezed container feeds `ceil(size / maxInlineSize)` in
  // #beforeRender, which flips the column count near the 1↔2 boundary and
  // leaves the page anchored mid-column (text clipped at the left edge).
  // Reserving the gap up front keeps the grid exactly fitting, so the margin is
  // precisely `settings.margins` on each side and the column count is stable.
  //
  // The width is additionally capped at MEASURE_EM_CAP ems (getReaderMeasure),
  // because a full-width column on a large display runs to ~190 characters per
  // line — far past the 45-75 that reads comfortably. Foliate's own 720px cap
  // used to do this job; sizing the column here removed it. The surplus width
  // is absorbed by the outer `minmax(half-gap, 1fr)` tracks of the same grid,
  // which are equal, so the capped column stays centred. `settings.margins` is
  // therefore a minimum margin, not an exact one.
  const columnWidth = measure.columnWidth;
  // Foliate re-renders synchronously from attributeChangedCallback, but only
  // for `flow` and `max-inline-size` — `gap` and `max-column-count` merely
  // write CSS variables. Setting `flow` first therefore rendered once with the
  // OLD gap/column values against the NEW container size, and that bad render
  // also ran #scrollToAnchor, which can leave the page anchored mid-column
  // (text clipped at the left edge). Write the non-rendering inputs first and
  // the rendering ones last, and skip attributes whose value did not change
  // (setAttribute fires the callback even for an identical value), so one
  // reflow costs exactly one render — always with fully updated values.
  const renderer = view.renderer;
  const setAttr = (name: string, value: string): boolean => {
    if (renderer.getAttribute(name) === value) return false;
    renderer.setAttribute(name, value);
    return true;
  };
  setAttr("gap", `${settings.margins}%`);
  setAttr("max-column-count", String(effectiveColumns));
  const flowRendered = setAttr("flow", isPaginated ? "paginated" : "scrolled");
  const inlineSizeRendered = setAttr("max-inline-size", `${columnWidth}px`);
  if (!flowRendered && !inlineSizeRendered) {
    // Nothing re-rendered above, either because only the non-rendering inputs
    // changed or because no attribute changed at all — the latter is every
    // height-only resize, e.g. the read-aloud bar opening above the text.
    // Foliate would eventually re-columnize from its own ResizeObserver, but
    // 150ms later and outside this call, where the caller can no longer tell
    // whether the reader's position survived. Render here so this function
    // always leaves exactly one relayout behind it, finished on return.
    renderer.render?.();
  }
  // Reflowable books retain Foliate's native slide so direct trackpad gestures
  // animate too. The shared transition layer detects this paginator and does
  // not add a second animation; fixed-layout PDF uses the container fallback.
  view.renderer.toggleAttribute(
    "animated",
    isPaginated
      && settings.pageTurnAnimation === "slide"
      && !prefersReducedMotion(),
  );
  return measure;
}

export function applyPdfLayout(
  view: LayoutView,
  settings: ReaderSettingsState,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const effectiveColumns = getEffectivePageColumns(settings, viewportWidth, viewportHeight);
  const columns = String(effectiveColumns);
  const spread = effectiveColumns === 2 ? "auto" : "none";
  if (view.renderer.getAttribute("max-column-count") !== columns) {
    view.renderer.setAttribute("max-column-count", columns);
  }
  if (view.renderer.getAttribute("spread") !== spread) {
    view.renderer.setAttribute("spread", spread);
  }
  return effectiveColumns;
}
