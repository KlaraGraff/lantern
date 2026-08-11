// Explicit extension: the unit tests import this module through Node's ESM
// loader, which does not do extensionless relative resolution the way Vite does.
import { builtinFonts, CJK_SANS, CJK_SERIF } from "./builtin-fonts.ts";
import type { PageColumns, ReaderSettingsState } from "./ReaderSettings";

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 48;

// Comfortable reading is 45-75 characters per line, and that range converts to
// almost the same em width in both scripts we care about: 66 Latin characters
// at ~0.5em average advance is ~33em, and ~35 CJK characters at 1em is ~35em.
// So one cap serves both. Fixed on purpose — this is a typographic constant,
// not a taste knob, and exposing it as a setting only invites bad values.
export const MEASURE_EM_CAP = 34;
// The other end of the same range: below this a width cap cannot help, because
// there is no surplus width to give away — only a smaller font can bring the
// line back into range.
//
// This used to be 22, on the assumption that 22em is ~45 Latin characters —
// i.e. an average advance of 0.5em. Measured against Literata, the font this
// app actually ships and defaults to, the advance is 0.495em and justified
// text laid out with `text-wrap: pretty` gives up a further ~4 characters per
// line, so 22em delivers ~40 characters, not 45. The old value therefore sat
// just under the real column width on a phone and never fired at all: the
// reader stayed at its declared size and ran ~41 characters per line, which
// left only six or seven word gaps to absorb each line's leftover space —
// the actual cause of the stretched-looking lines on mobile, and something no
// alignment or hyphenation setting can fix.
//
// 25em is the same 45-character floor restated in measured units:
// (45 + 4) * 0.495 = 24.3em, rounded up for headroom.
export const MEASURE_EM_MIN = 25;

/** Clamp a reading column to the maximum comfortable line length. */
export function capMeasureWidth(availableWidth: number, fontSize: number): number {
  return Math.min(availableWidth, MEASURE_EM_CAP * fontSize);
}

/**
 * Font size to render at, given how much width one column actually gets.
 * Only ever shrinks: a size the user chose on a wide screen must never be
 * forced up on a narrow one. Render-time only — never written back to settings.
 */
export function getEffectiveFontSize(
  settings: Pick<ReaderSettingsState, "fontSize" | "narrowFontShrink">,
  availableWidth: number,
): number {
  if (!settings.narrowFontShrink) return settings.fontSize;
  const fitted = Math.floor(Math.max(1, availableWidth) / MEASURE_EM_MIN);
  return Math.min(settings.fontSize, Math.max(FONT_SIZE_MIN, fitted));
}

export interface ReaderFontOption {
  id: string;
  label: string;
  family: string;
  group: "system" | "built-in" | "custom";
  filePath?: string;
}

export interface ReaderCjkFontOption {
  id: string;
  label: string;
  /**
   * Not a full chain — just the CJK segment `getFontFamily` splices into a
   * Latin font's own chain, in place of whichever isolated system CJK family
   * (`CJK_SERIF` / `CJK_SANS`, from builtin-fonts.ts) that chain already
   * names. `system` and `system-sans` are themselves that same isolated
   * family, so selecting either of those is a straight swap; `enhanced`
   * leads with the downloadable pack and keeps the system serif behind it,
   * so it degrades to plain `system` until the pack is actually installed.
   */
  family: string;
}

/**
 * The Chinese half of the reader's font pair — independent of `fonts` above,
 * which is Latin-only now that the two are set separately (see `getFontFamily`).
 *
 * `enhanced` is `"Lantern Enhanced Chinese Serif"` (installed by
 * `installEnhancedFontFace` in enhanced-fonts.ts), listed *ahead* of the
 * isolated system serif face. It has to lead: both faces are fenced to the
 * same CJK codepoints, so whichever comes first wins every character they
 * share, and behind the system face the pack would only ever surface for
 * glyphs the OS lacks — an option the user selected that visibly did nothing.
 * The system face stays behind it as the fallback for readers who have not
 * downloaded the pack, so the option is safe to select either way.
 */
export const cjkFonts: ReaderCjkFontOption[] = [
  { id: "system", label: "System Serif", family: CJK_SERIF },
  { id: "system-sans", label: "System Sans", family: CJK_SANS },
  { id: "enhanced", label: "Enhanced Serif", family: `"Lantern Enhanced Chinese Serif", ${CJK_SERIF}` },
];

export const fonts: ReaderFontOption[] = [
  // These are Latin-only faces too, so they name the same CJK fallbacks as the
  // bundled ones. Without that, which font Chinese lands in depends on the
  // platform: Songti under macOS, SimSun under Windows.
  { id: "system", label: "System", family: `system-ui, -apple-system, ${CJK_SANS}, sans-serif`, group: "system" },
  { id: "georgia", label: "Georgia", family: `Georgia, ${CJK_SERIF}, serif`, group: "system" },
  { id: "palatino", label: "Palatino", family: `Palatino, ${CJK_SERIF}, serif`, group: "system" },
  { id: "times", label: "Times New Roman", family: `"Times New Roman", ${CJK_SERIF}, serif`, group: "system" },
  // Grouped with the system faces, not the built-ins: no Inter file ships with
  // the app, so this renders as Inter only where the machine already has it and
  // falls through to the system sans everywhere else.
  { id: "inter", label: "Inter", family: `"Inter", system-ui, ${CJK_SANS}, sans-serif`, group: "system" },
  ...builtinFonts.map((font): ReaderFontOption => ({
    id: font.id,
    label: font.label,
    family: `"${font.label}", ${font.fallback}`,
    group: "built-in",
  })),
];

const themes = [
  { id: "original", label: "Original", color: "bg-reader-original-bg border border-reader-original-border", pdf: true },
  { id: "paper", label: "Reading Paper", color: "bg-reader-paper-bg border border-reader-original-border", pdf: true },
  { id: "quiet", label: "Gray", color: "bg-reader-quiet-bg", pdf: true },
  { id: "dark", label: "Dark", color: "bg-reader-dark-bg border border-reader-dark-border", pdf: true },
  { id: "custom", label: "Custom", color: "border border-reader-original-border", pdf: true },
] as const;

export type ReaderTheme = (typeof themes)[number]["id"];
export interface ReaderCustomTheme { color: string; opacity: number }
export type ReaderFont = string;

export interface ReaderCapabilities {
  // Selection and stored annotation support are deliberately separate from
  // automatic word markers. PDF text layers can support the former without
  // making a promise that we can reliably mark every vocabulary occurrence.
  supportsSelection: boolean;
  supportsManualAnnotations: boolean;
  supportsWordMarkers: boolean;
  supportsCfiNavigation: boolean;
  supportsReflowSettings: boolean;
  supportsSpread: boolean;
  supportsContinuousScroll: boolean;
  supportsZoom: boolean;
}

export function getEffectivePageColumns(
  settings: Pick<ReaderSettingsState, "readingMode" | "pageColumns">,
  viewportWidth: number,
  viewportHeight: number,
): PageColumns {
  if (settings.readingMode !== "paginated" || settings.pageColumns !== 2) return 1;
  return Math.max(1, viewportWidth) > Math.max(1, viewportHeight) ? 2 : 1;
}

export interface ReaderMeasure {
  columns: PageColumns;
  /** Size to render at; equals the user's size unless the column is too narrow. */
  fontSize: number;
  /** Width of one text column, capped at the comfortable line length. */
  columnWidth: number;
}

/**
 * Resolve the geometry of one reflowable page: how many columns, how wide each
 * one may be, and at what size to set the text. `settings.margins` is the
 * minimum margin — when the cap binds, the surplus widens the margin further.
 */
export function getReaderMeasure(
  settings: Pick<ReaderSettingsState,
    "readingMode" | "pageColumns" | "margins" | "fontSize" | "narrowFontShrink">,
  viewportWidth: number,
  viewportHeight: number,
): ReaderMeasure {
  const width = Math.max(1, viewportWidth);
  const columns = getEffectivePageColumns(settings, width, viewportHeight);
  const marginFraction = Math.min(Math.max(settings.margins, 0), 100) / 100;
  const available = (width * (1 - marginFraction)) / columns;
  const fontSize = getEffectiveFontSize(settings, available);
  return { columns, fontSize, columnWidth: capMeasureWidth(available, fontSize) };
}

/** Smallest gutter the plain-text reader keeps, whatever the margin setting. */
export const TEXT_READER_MIN_PADDING = 12;

/**
 * The same measure rules for the plain-text reader, which lays itself out with
 * CSS columns instead of foliate. `padding` is the gutter on each side of a page
 * slot; it grows past the margin setting when the width cap frees up space, so
 * the column stays centred in its slot exactly as foliate's grid centres its own.
 */
export function getTextReaderMeasure(
  settings: Pick<ReaderSettingsState, "margins" | "fontSize" | "narrowFontShrink">,
  containerWidth: number,
  columns: number,
): { fontSize: number; columnWidth: number; padding: number } {
  const slot = Math.max(1, containerWidth) / Math.max(1, columns);
  const marginPercent = Math.min(30, Math.max(0, settings.margins));
  const minPadding = Math.max(TEXT_READER_MIN_PADDING, slot * marginPercent / 100);
  const available = Math.max(1, slot - minPadding * 2);
  const fontSize = getEffectiveFontSize(settings, available);
  const columnWidth = capMeasureWidth(available, fontSize);
  return { fontSize, columnWidth, padding: minPadding + (available - columnWidth) / 2 };
}

export function getReaderCapabilities(
  format?: string,
  renditionLayout?: string,
): ReaderCapabilities {
  const normalizedFormat = (format || "epub").toLowerCase();
  if (normalizedFormat === "epub" && renditionLayout === "pre-paginated") {
    return {
      supportsSelection: true,
      supportsManualAnnotations: true,
      supportsWordMarkers: true,
      supportsCfiNavigation: true,
      supportsReflowSettings: false,
      // Foliate's fixed-layout renderer uses a different `spread` API than the
      // reflowable max-column-count control. Hide the ineffective control.
      supportsSpread: false,
      supportsContinuousScroll: false,
      supportsZoom: false,
    };
  }
  switch (normalizedFormat) {
    case "epub":
      return {
        supportsSelection: true,
        supportsManualAnnotations: true,
        supportsWordMarkers: true,
        supportsCfiNavigation: true,
        supportsReflowSettings: true,
        supportsSpread: true,
        supportsContinuousScroll: true,
        supportsZoom: false,
      };
    case "text":
      return {
        supportsSelection: true,
        supportsManualAnnotations: true,
        supportsWordMarkers: true,
        supportsCfiNavigation: true,
        supportsReflowSettings: true,
        supportsSpread: true,
        supportsContinuousScroll: true,
        supportsZoom: false,
      };
    case "pdf":
      return {
        supportsSelection: true,
        supportsManualAnnotations: true,
        supportsWordMarkers: false,
        supportsCfiNavigation: true,
        supportsReflowSettings: false,
        supportsSpread: true,
        supportsContinuousScroll: true,
        supportsZoom: true,
      };
    case "mobi":
    case "azw":
    case "azw3":
    case "fb2":
    case "fbz":
      return {
        supportsSelection: false,
        supportsManualAnnotations: false,
        supportsWordMarkers: false,
        supportsCfiNavigation: false,
        supportsReflowSettings: true,
        supportsSpread: true,
        supportsContinuousScroll: true,
        supportsZoom: false,
      };
    case "cbz":
      return {
        supportsSelection: false,
        supportsManualAnnotations: false,
        supportsWordMarkers: false,
        supportsCfiNavigation: false,
        supportsReflowSettings: false,
        supportsSpread: false,
        supportsContinuousScroll: false,
        supportsZoom: false,
      };
    default:
      return {
        supportsSelection: false,
        supportsManualAnnotations: false,
        supportsWordMarkers: false,
        supportsCfiNavigation: false,
        supportsReflowSettings: false,
        supportsSpread: false,
        supportsContinuousScroll: false,
        supportsZoom: false,
      };
  }
}

export function getReaderThemes() {
  return themes;
}

/**
 * Latin and CJK are set separately (`cjkFonts` above), but `fonts[].family`
 * still bakes in a default CJK segment per Latin font — the isolated serif
 * face for serif Latin fonts, the isolated sans face for sans ones — because
 * that per-font string is also read directly, with no `cjkId` in reach, by
 * `MarkerStyleSettings.tsx`'s marker-font preview.
 *
 * Omitting `cjkId` returns that baked-in chain unchanged — the single-argument
 * call sites (`marker-style.ts`, `useFoliateAnnotations.ts`) predate the CJK
 * setting and must keep rendering exactly as before. Passing one splices the
 * chosen CJK segment in over whichever isolated system face (`CJK_SERIF` or
 * `CJK_SANS`) the baked-in chain already names, keeping the chain's order:
 * Latin family, then CJK family, then the generic keyword.
 *
 * `"system"` is spliced like any other id rather than short-circuiting to the
 * baked-in chain, because the baked-in CJK segment tracks the *Latin* font —
 * sans for Inter, serif for Georgia. Short-circuiting would mean picking
 * 系统宋体 alongside a sans Latin font silently rendered 黑体, and that the
 * Chinese font changed whenever the Latin one did. Setting them separately is
 * the whole point of the pair, so the CJK id wins outright.
 */
export function getFontFamily(fontId: ReaderFont, cjkId?: string): string {
  // An imported font is a Latin face like any other, so it names the isolated
  // CJK serif too. Without that segment there is nothing for the splice below
  // to replace, and choosing a Chinese font while reading in a custom Latin
  // font would quietly do nothing.
  const base = fontId.startsWith("custom-")
    ? `${customFontFamily(fontId)}, ${CJK_SERIF}, serif`
    : fonts.find((font) => font.id === fontId)?.family ?? "Inter, system-ui, sans-serif";
  if (cjkId === undefined) return base;
  const cjkFamily = cjkFonts.find((font) => font.id === cjkId)?.family;
  if (!cjkFamily) return base;
  if (base.includes(CJK_SERIF)) return base.replace(CJK_SERIF, cjkFamily);
  if (base.includes(CJK_SANS)) return base.replace(CJK_SANS, cjkFamily);
  return base;
}

export function isReaderFontAvailable(fontId: ReaderFont): boolean {
  return fonts.some((font) => font.id === fontId);
}

/**
 * Options for a reader font picker. A font id that is not registered still gets
 * an entry: a deleted custom font would otherwise leave the control blank, with
 * nothing to say that the book is no longer rendering in the font it names.
 */
export function getReaderFontOptions(
  selectedFontId: ReaderFont,
  unavailableLabel: string,
): Array<{ value: string; label: string }> {
  const options = fonts.map((font) => ({ value: font.id, label: font.label }));
  if (!isReaderFontAvailable(selectedFontId)) {
    options.push({ value: selectedFontId, label: unavailableLabel });
  }
  return options;
}

export function customFontFamily(id: string) {
  return `"LanternCustom-${id.replace(/[^a-zA-Z0-9_-]/g, "")}"`;
}

export function setCustomReaderFonts(customFonts: Array<{ id: string; family_name: string; file_path: string }>) {
  const next = fonts.filter((font) => font.group !== "custom");
  for (const font of customFonts) {
    next.push({
      id: font.id,
      label: font.family_name,
      family: `${customFontFamily(font.id)}, serif`,
      group: "custom",
      filePath: font.file_path,
    });
  }
  fonts.splice(0, fonts.length, ...next);
}

export const DEFAULT_READER_CUSTOM_THEME: ReaderCustomTheme = { color: "#DDE8D8", opacity: 70 };

export function parseReaderCustomTheme(value: unknown): ReaderCustomTheme {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  const record = source && typeof source === "object" ? source as Partial<ReaderCustomTheme> : {};
  return {
    color: typeof record.color === "string" && /^#[0-9a-f]{6}$/i.test(record.color)
      ? record.color.toUpperCase()
      : DEFAULT_READER_CUSTOM_THEME.color,
    opacity: Number.isFinite(record.opacity)
      ? Math.min(100, Math.max(0, Number(record.opacity)))
      : DEFAULT_READER_CUSTOM_THEME.opacity,
  };
}

function rgb(color: string) {
  return [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
}

function hex(channels: number[]) {
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function luminance(color: string) {
  const channels = rgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left: string, right: string) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function mix(foreground: string, background: string, opacity: number) {
  const fg = rgb(foreground);
  const bg = rgb(background);
  const alpha = opacity / 100;
  return hex(fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)));
}

export function getCustomThemeStyles(customTheme: ReaderCustomTheme) {
  const normalized = parseReaderCustomTheme(customTheme);
  const body = mix(normalized.color, "#FFFFFF", normalized.opacity);
  const lightBackground = luminance(body) >= 0.42;
  let text = lightBackground ? "#2A2620" : "#E7E7EA";
  const target = lightBackground ? "#000000" : "#FFFFFF";
  for (let step = 1; contrast(body, text) < 4.5 && step <= 10; step += 1) {
    text = mix(target, text, step * 10);
  }
  return { body, text };
}

export function getThemeStyles(themeId: ReaderTheme, customTheme = DEFAULT_READER_CUSTOM_THEME) {
  switch (themeId) {
    // The four stock themes follow the lineup most readers converge on
    // (Apple Books, Kindle, WeChat Reading): plain white, a true sepia paper,
    // a dim gray for low light, and a near-black night theme.
    case "paper":
      // Warm and genuinely tinted — the old #FAF7F0 was within a hair of
      // plain white, which reads as glare in a dim room.
      return { body: "#F2E9D8", text: "#3B3325" };
    case "quiet":
      // A dim mid-dark gray with soft (not white) text: the low-light theme
      // between paper and night. The old #71717b/#fafafa pairing sat at the
      // 4.5:1 contrast floor and haloed badly.
      return { body: "#45454C", text: "#D9D9DE" };
    case "dark":
      return { body: "#121216", text: "#C9C9D1" };
    case "custom":
      return getCustomThemeStyles(customTheme);
    default:
      return { body: "#ffffff", text: "#0a0a0a" };
  }
}

/**
 * The reader's out-of-the-box theme: 「阅读纸」(sepia paper), regardless of the
 * system's light/dark mode. It used to follow dark mode into the "dark" theme
 * and light mode into "paper", but a fresh two-page layout landing on either
 * "dark" or the stark white "original" theme read as harsh — 「阅读纸」 is the
 * one default that looks right either way.
 */
export function getDefaultReaderTheme(): ReaderTheme {
  return "paper";
}
