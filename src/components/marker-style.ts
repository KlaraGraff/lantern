import { getFontFamily } from "./reader-settings.ts";

export const MARKER_STYLE_SETTING_KEY = "marker_style_config";

export type MarkerFontChoice = "inherit" | "reader" | string;

export interface MarkerVisualStyle {
  color: string;
  opacity: number;
  background: boolean;
  underline: boolean;
  bold: boolean;
  font: MarkerFontChoice;
}

export interface MarkerStyleConfig {
  version: number;
  wordMatchScope: "current" | "book" | "forms";
  manual: MarkerVisualStyle;
  automaticFollowsManual: boolean;
  automatic: MarkerVisualStyle;
  /**
   * Whether whole-word markers in a paginated book may carry weight and font.
   * Off by default: those treatments change how wide the text is, so marking a
   * word reflows the page it is on. Colour, background, and underline never do.
   */
  layoutAffectingMarkers: boolean;
}

export const MARKER_COLOR_PRESETS = [
  "#E9B949",
  "#4FAE91",
  "#5B8FD9",
  "#CF6F8A",
  "#8A8F98",
] as const;

/** A range the reader marked themselves: the warmest, most solid thing on the page. */
const DEFAULT_MANUAL: MarkerVisualStyle = {
  color: "#E9B949",
  opacity: 34,
  background: true,
  underline: false,
  bold: false,
  font: "inherit",
};

/**
 * A range the app marked on the reader's behalf, after a lookup. Faint enough
 * to read straight past, and carrying an underline the manual style does not,
 * so the two never have to be told apart by colour alone.
 */
const DEFAULT_AUTOMATIC: MarkerVisualStyle = {
  color: "#8D7C65",
  opacity: 16,
  background: true,
  underline: true,
  bold: false,
  font: "inherit",
};

export const MARKER_STYLE_VERSION = 2;

export function createDefaultMarkerStyleConfig(): MarkerStyleConfig {
  return {
    version: MARKER_STYLE_VERSION,
    wordMatchScope: "book",
    manual: { ...DEFAULT_MANUAL },
    automaticFollowsManual: false,
    automatic: { ...DEFAULT_AUTOMATIC },
    layoutAffectingMarkers: false,
  };
}

function normalizeColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function normalizeVisualStyle(value: unknown, fallback: MarkerVisualStyle): MarkerVisualStyle {
  const source = value && typeof value === "object" ? value as Partial<MarkerVisualStyle> : {};
  const background = source.background ?? fallback.background;
  const underline = source.underline ?? fallback.underline;
  const bold = source.bold ?? fallback.bold;
  // At least one treatment must remain active so a saved marker cannot become
  // invisible. Font choice is deliberately not counted as a marker treatment.
  const hasTreatment = background || underline || bold;
  return {
    color: normalizeColor(source.color, fallback.color),
    opacity: Math.min(100, Math.max(5, Number.isFinite(source.opacity) ? Number(source.opacity) : fallback.opacity)),
    background: hasTreatment ? background : true,
    underline,
    bold,
    font: typeof source.font === "string" && source.font.trim() ? source.font : fallback.font,
  };
}

export function parseMarkerStyleConfig(value: unknown): MarkerStyleConfig {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      source = null;
    }
  }
  const parsed = source && typeof source === "object" ? source as Partial<MarkerStyleConfig> & { markMatchingWords?: boolean } : {};
  const defaults = createDefaultMarkerStyleConfig();
  // v1 shipped `automaticFollowsManual: true`, which made an automatic mark
  // render identically to a manual one — the two kinds of mark were the same
  // colour because the setting said to copy it. Every v1 config carries that
  // `true` whether or not anyone chose it, so the stored value cannot say which
  // it was, and it is read here as the default it almost always was.
  //
  // Only that one field is migrated. A v1 config that turned the toggle *off*
  // is unambiguous — nothing but a deliberate choice produces it — so it, and
  // the `automatic` style it makes visible, survive untouched.
  const stored = typeof parsed.version === "number" ? parsed.version : 1;
  const inheritedFollowsManual = stored < MARKER_STYLE_VERSION && parsed.automaticFollowsManual !== false;
  return {
    version: MARKER_STYLE_VERSION,
    wordMatchScope: parsed.wordMatchScope === "current" || parsed.wordMatchScope === "book" || parsed.wordMatchScope === "forms"
      ? parsed.wordMatchScope
      : parsed.markMatchingWords === false ? "current" : "book",
    manual: normalizeVisualStyle(parsed.manual, defaults.manual),
    automaticFollowsManual: inheritedFollowsManual
      ? defaults.automaticFollowsManual
      : parsed.automaticFollowsManual ?? defaults.automaticFollowsManual,
    automatic: normalizeVisualStyle(parsed.automatic, defaults.automatic),
    layoutAffectingMarkers: parsed.layoutAffectingMarkers === true,
  };
}

export function serializeMarkerStyleConfig(config: MarkerStyleConfig) {
  return JSON.stringify(parseMarkerStyleConfig(config));
}

export function effectiveAutomaticMarkerStyle(config: MarkerStyleConfig) {
  return config.automaticFollowsManual ? config.manual : config.automatic;
}

export function markerFontFamily(font: MarkerFontChoice, readerFont?: string) {
  if (font === "inherit") return undefined;
  if (font === "reader") return readerFont;
  return getFontFamily(font);
}

export function markerStyleCss(style: MarkerVisualStyle, fontFamily?: string) {
  const alpha = Math.round((style.opacity / 100) * 255).toString(16).padStart(2, "0");
  return {
    backgroundColor: style.background ? `${style.color}${alpha}` : "transparent",
    textDecoration: style.underline ? "underline" : "none",
    textDecorationColor: style.color,
    textDecorationThickness: style.underline ? "1.5px" : undefined,
    textUnderlineOffset: style.underline ? "0.14em" : undefined,
    fontWeight: style.bold ? 700 : undefined,
    fontFamily: fontFamily || undefined,
  } as const;
}

// Styling for a marker wrapped around book text. An inline background covers
// the font box, so the marker is as tall as the word and no taller. Only
// properties that cannot move a glyph belong here: padding, weight, or family
// would reflow the page as words are looked up, which is why
// `markerOverlayStyle` strips the layout-affecting treatments first.
export function markerHighlightCss(style: MarkerVisualStyle, fontFamily?: string) {
  const alpha = Math.round((style.opacity / 100) * 255).toString(16).padStart(2, "0");
  return [
    style.background ? `background-color: ${style.color}${alpha}; border-radius: 0.15em;` : "",
    style.underline
      ? `text-decoration: underline; text-decoration-color: ${style.color}; text-decoration-thickness: 1.5px; text-underline-offset: 0.14em;`
      : "",
    style.bold ? "font-weight: 700;" : "",
    fontFamily ? `font-family: ${fontFamily};` : "",
  ].filter(Boolean).join(" ");
}

// Drops the treatments that would move text. An SVG overlay cannot render them
// at all, and inside a paginated book they reflow the page every time a word is
// marked — which whole-word markers may do once the reader opts in.
export function markerOverlayStyle(style: MarkerVisualStyle): MarkerVisualStyle {
  return { ...style, bold: false, font: "inherit" };
}

/** The style a wrapped whole-word marker renders with, honouring the opt-in. */
export function wordMarkerCss(
  config: MarkerStyleConfig,
  style: MarkerVisualStyle,
  readerFontFamily?: string,
): string {
  return config.layoutAffectingMarkers
    ? markerHighlightCss(style, markerFontFamily(style.font, readerFontFamily))
    : markerHighlightCss(markerOverlayStyle(style));
}
