import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MARKER_COLOR_PRESETS,
  effectiveAutomaticMarkerStyle,
  markerStyleCss,
  type MarkerStyleConfig,
  type MarkerVisualStyle,
} from "../marker-style";
import {
  markBlendMode,
  systemMark,
  type SystemMark,
  type SystemMarkId,
  markCollisions,
  markInvisibleOn,
  configuredMarksLookAlike,
  MARKER_VISIBILITY_KEYS,
  markerVisibilitySummary,
  type MarkerVisibility,
  type MarkerVisibilityKey,
} from "../mark-palette";
import { fonts, getDefaultReaderTheme, getThemeStyles, type ReaderTheme } from "../reader-settings";
import { installCustomFontFaces, type CustomFontRecord } from "../custom-fonts";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import ColorSwatches from "../ui/ColorSwatches";
import { ROW_CONTROL_WIDTH } from "./types";
import WordFormsManager from "./WordFormsManager";

interface MarkerStyleSettingsProps {
  value: MarkerStyleConfig;
  onChange: (value: MarkerStyleConfig) => void;
  /**
   * The lookup-marking toggle, owned by the tools panel but shown here with the
   * other marker switches — above the word-form list, which is long enough to
   * bury anything placed after it.
   */
  lookupRow?: React.ReactNode;
  /** The global default for which vocabulary marks the text shows. */
  visibility: MarkerVisibility;
  onVisibilityChange: (value: MarkerVisibility) => void;
  /**
   * The opt-out from fading (`lookup_markers_never_fade`). It belongs under the
   * lookup switch rather than beside it: it is not a fourth kind of mark, it is
   * a qualifier on the one above it, and it says nothing while that one is off.
   */
  lookupNeverFade: boolean;
  onLookupNeverFadeChange: (value: boolean) => void;
}

/** Which of the two styles the controls below the sample are editing. */
type EditTarget = "manual" | "automatic";

function fontFamilyForMarker(font: string) {
  if (font === "inherit" || font === "reader") return undefined;
  return fonts.find((item) => item.id === font)?.family;
}

function withAlpha(color: string, opacity: number) {
  return `${color}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
}

/**
 * A system mark as CSS, on the page it is being shown against. The book draws
 * these as SVG over the text, which a sample paragraph cannot do, so this is
 * the closest CSS equivalent — same colour, same strength, same shape, same
 * blend. Near enough to judge a colour against.
 */
function systemMarkCss(mark: SystemMark, backdrop: string): CSSProperties {
  if (mark.shape === "wash") {
    return {
      backgroundColor: withAlpha(mark.color, mark.opacity),
      // Blended into the page in the book so the words stay readable underneath,
      // and blended the same way here — which is what makes the two panes worth
      // showing side by side, since the direction differs between them.
      mixBlendMode: markBlendMode(mark, backdrop),
      borderRadius: "0.15em",
    };
  }
  return {
    textDecoration: "underline",
    textDecorationColor: withAlpha(mark.color, mark.opacity),
    textDecorationStyle: mark.dashed ? "dashed" : "solid",
    textDecorationThickness: "1.5px",
    textUnderlineOffset: "0.14em",
  };
}

const MARK_LABEL_KEY: Record<SystemMarkId, string> = {
  reading: "settings.tools.markers.markReading",
  vocabNew: "vocab.mastery.new",
  learning: "vocab.mastery.learning",
  familiar: "vocab.mastery.familiar",
};

/**
 * What each visibility switch says, and which mark it draws its sample chip
 * with. `mark: null` is the lookup switch: a lookup mark is not one of the
 * palette's fixed marks at all, it is drawn with whatever the reader set the
 * *automatic* style to, so its chip has to be read off the live config.
 */
const VISIBILITY_ROW: Record<MarkerVisibilityKey, {
  mark: SystemMarkId | null;
  titleKey: string;
  hintKey: string;
}> = {
  showLookupMarkers: {
    mark: null,
    titleKey: "settings.tools.markers.visibility.lookup",
    hintKey: "settings.tools.markers.visibility.lookupHint",
  },
  showNewVocabMarkers: {
    mark: "vocabNew",
    titleKey: "settings.tools.markers.visibility.vocabNew",
    hintKey: "settings.tools.markers.visibility.vocabNewHint",
  },
  // Two tiers behind one switch, so the chip shows the `learning` mark and the
  // hint names both. The `familiar` dash still appears in the sample paragraph
  // above, which is where the two are seen side by side.
  showLearningMarkers: {
    mark: "learning",
    titleKey: "settings.tools.markers.visibility.learning",
    hintKey: "settings.tools.markers.visibility.learningHint",
  },
};

/** Partial: only the themes `markInvisibleOn` can name are ever looked up here. */
const BACKDROP_LABEL_KEY: Partial<Record<ReaderTheme, string>> = {
  original: "readerSettings.themeOriginal",
  paper: "readerSettings.themeSepia",
  quiet: "readerSettings.themeGray",
  dark: "readerSettings.themeDark",
};

function clampOpacity(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Rec. 709 luma, 0 to 1 — enough to choose a legible icon to lay over a fill. */
function relativeLuma(hex: string) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function normalizeHexColor(value: string, fallback: string) {
  const trimmed = value.trim();
  const normalized = (trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}

/**
 * Opacity as a number rather than the slider it replaced: the row it now shares
 * with the swatches has no width for a track. Arrow keys keep the sweep a slider
 * gave, a percent at a time, so a value can still be found by eye off the sample.
 */
function OpacityField({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    onChange(clampOpacity(parsed));
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] text-text-muted">{label}</span>
      <div className="relative">
        <input
          value={draft}
          inputMode="numeric"
          maxLength={3}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(event.currentTarget.value);
              return;
            }
            const step = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            // Stepped off what is on screen, not off the last committed value —
            // otherwise an arrow press after typing jumps somewhere else.
            const typed = Number.parseInt(draft, 10);
            onChange(clampOpacity((Number.isNaN(typed) ? value : typed) + step));
          }}
          className="h-7 w-14 rounded-md border border-border bg-bg-input pl-2 pr-5 text-[11px] tabular-nums text-text-primary outline-none focus:border-accent"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-text-muted">%</span>
      </div>
    </div>
  );
}

/**
 * The sixth swatch, and the only one that is not a preset — it opens the picker.
 * So it wears the icon rather than a fill until a colour outside the presets is
 * actually in use, at which point it becomes the swatch showing that colour.
 */
function CustomColorButton({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(color);
  const isCustom = !MARKER_COLOR_PRESETS.some((preset) => preset === color);
  const pickerLabel = t("settings.tools.markers.colorPicker");

  useEffect(() => setHexDraft(color), [color]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const commitHex = () => {
    const normalized = normalizeHexColor(hexDraft, color);
    setHexDraft(normalized);
    onChange(normalized);
  };

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={pickerLabel}
        aria-expanded={open}
        title={pickerLabel}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={`flex size-7 items-center justify-center rounded-full border ${
          isCustom
            ? "border-black/10 ring-2 ring-accent ring-offset-2 ring-offset-bg-surface"
            : "border-border bg-bg-surface hover:bg-bg-input"
        }`}
        style={isCustom ? { backgroundColor: color } : undefined}
      >
        <Pipette
          size={13}
          className={isCustom ? undefined : "text-text-muted"}
          style={isCustom ? { color: relativeLuma(color) > 0.6 ? "#1B1B1F" : "#FFFFFF" } : undefined}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 flex items-center gap-2 rounded-lg border border-border bg-bg-surface p-2 shadow-popover">
          <label className="relative size-7 shrink-0 overflow-hidden rounded-full border border-border" title={pickerLabel}>
            <input
              type="color"
              value={color}
              aria-label={pickerLabel}
              onChange={(event) => onChange(event.target.value.toUpperCase())}
              className="absolute -inset-2 size-12 cursor-pointer border-0 bg-transparent p-0"
            />
          </label>
          <input
            value={hexDraft}
            maxLength={7}
            aria-label={t("settings.tools.markers.hexColor")}
            onChange={(event) => setHexDraft(event.target.value.toUpperCase())}
            onBlur={commitHex}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitHex();
            }}
            className="h-7 w-[88px] rounded-md border border-border bg-bg-input px-2 font-mono text-[11px] uppercase text-text-primary outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}

function TreatmentToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-8 rounded-md border px-3 text-[11px] font-medium transition-colors ${
        active
          ? "border-accent bg-accent-bg text-accent-text"
          : "border-border bg-bg-surface text-text-secondary hover:bg-bg-input"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The sample paragraph, carrying one of every mark a page can show. The two
 * styles the reader is editing are drawn from the live config, so a colour
 * change lands here before it lands in a book.
 */
function SamplePane({
  theme,
  buildStyles,
}: {
  theme: "paper" | "dark";
  buildStyles: (backdrop: string) => Record<string, CSSProperties | undefined>;
}) {
  const { t } = useTranslation();
  const { body, text } = getThemeStyles(theme);
  const styles = buildStyles(body);
  // Odd positions are placeholder names, even ones the prose between them.
  const parts = t("settings.tools.markers.sampleText").split(/\{\{(\w+)\}\}/);

  return (
    <div
      className="min-w-0 rounded-md px-3 py-2.5 text-[12px] leading-[21px]"
      style={{ backgroundColor: body, color: text }}
    >
      {parts.map((part, index) => (index % 2 === 0
        ? <span key={index}>{part}</span>
        : (
          <span key={index} style={styles[part]}>
            {t(`settings.tools.markers.sample${part[0].toUpperCase()}${part.slice(1)}`)}
          </span>
        )))}
    </div>
  );
}

function StyleControls({
  value,
  onChange,
}: {
  value: MarkerVisualStyle;
  onChange: (value: MarkerVisualStyle) => void;
}) {
  const { t } = useTranslation();
  const update = <K extends keyof MarkerVisualStyle>(key: K, next: MarkerVisualStyle[K]) => {
    const candidate = { ...value, [key]: next };
    if (!candidate.background && !candidate.underline && !candidate.bold) return;
    onChange(candidate);
  };
  const collisions = markCollisions(value);
  const invisibleOn = markInvisibleOn(value);
  // These chips sit on the settings panel rather than on a page, so the nearest
  // truth about what they will blend into is which way the app itself is lit.
  const chipBackdrop = getThemeStyles(getDefaultReaderTheme()).body;
  const fontOptions = [
    { value: "inherit", label: t("settings.tools.markers.followOriginal") },
    { value: "reader", label: t("settings.tools.markers.followReaderFont") },
    ...fonts.map((font) => ({ value: font.id, label: font.label })),
  ];

  return (
    <div className="space-y-3 pb-4">
      {collisions.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent-bg px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-[11px] leading-[17px] text-text-secondary">{t("settings.tools.markers.collision")}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-primary">
              {collisions.map((id) => (
                <span key={id} style={systemMarkCss(systemMark[id], chipBackdrop)}>{t(MARK_LABEL_KEY[id])}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {invisibleOn.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent-bg px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-[11px] leading-[17px] text-text-secondary">{t("settings.tools.markers.invisible")}</p>
            {/* Named on their own paper: the complaint is about a page colour, and
                the page colour is the part a name alone does not convey. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              {invisibleOn.map((theme) => {
                const { body, text } = getThemeStyles(theme);
                return (
                  <span
                    key={theme}
                    className="rounded border border-black/10 px-1.5 py-0.5"
                    style={{ backgroundColor: body, color: text }}
                  >
                    {t(BACKDROP_LABEL_KEY[theme] ?? theme)}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-[11px] text-text-muted">{t("settings.tools.markers.treatments")}</p>
        <div className="flex flex-wrap gap-2">
          <TreatmentToggle active={value.background} onClick={() => update("background", !value.background)}>
            {t("settings.tools.markers.background")}
          </TreatmentToggle>
          <TreatmentToggle active={value.underline} onClick={() => update("underline", !value.underline)}>
            {t("settings.tools.markers.underline")}
          </TreatmentToggle>
          <TreatmentToggle active={value.bold} onClick={() => update("bold", !value.bold)}>
            {t("settings.tools.markers.bold")}
          </TreatmentToggle>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium text-text-primary">{t("settings.tools.markers.font")}</p>
          <p className="text-[10px] leading-4 text-text-muted">{t("settings.tools.markers.fontHint")}</p>
        </div>
        <Select className={ROW_CONTROL_WIDTH} value={value.font} onChange={(font) => update("font", font)} options={fontOptions} />
      </div>
    </div>
  );
}

/**
 * The global default for which vocabulary marks the text shows.
 *
 * Every row carries a chip drawn the way the mark is actually drawn, which
 * makes this block the legend the app never had: nothing else anywhere tells a
 * reader that the amber underline is a new word and the grey dash is one they
 * half-know. The samples above obey these switches too — a setting whose effect
 * you can only see by leaving the page is a setting you tune by guessing.
 *
 * Three rows, four mastery tiers. A mastered word is drawn as plain text, so it
 * has no row here and never had a switch worth keeping.
 */
function VisibilitySection({
  visibility,
  automatic,
  onChange,
  lookupNeverFade,
  onLookupNeverFadeChange,
}: {
  visibility: MarkerVisibility;
  automatic: MarkerVisualStyle;
  onChange: (value: MarkerVisibility) => void;
  lookupNeverFade: boolean;
  onLookupNeverFadeChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  // The same reasoning the collision chips use: these sit on the settings panel
  // rather than on a page of a book, so the nearest truth about what they blend
  // into is which way the app itself is lit.
  const { body: chipBackdrop, text: chipText } = getThemeStyles(getDefaultReaderTheme());
  const summary = markerVisibilitySummary(visibility);
  // Picked whole, never assembled: "2 / 3" reads differently in a language that
  // counts with measure words, and a sentence stitched together in JSX cannot be
  // reordered by a translator.
  const summaryLabel = summary.state === "all"
    ? t("settings.tools.markers.visibility.summaryAll", { total: summary.total })
    : summary.state === "none"
      ? t("settings.tools.markers.visibility.summaryNone")
      : t("settings.tools.markers.visibility.summaryPartial", { shown: summary.shown, total: summary.total });

  return (
    <div className="border-t border-border-light pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-text-primary">
          {t("settings.tools.markers.visibility.title")}
        </p>
        <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{summaryLabel}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-[17px] text-text-muted">
        {t("settings.tools.markers.visibility.hint")}
      </p>

      <div className="mt-1.5">
        {MARKER_VISIBILITY_KEYS.map((key) => {
          const row = VISIBILITY_ROW[key];
          const shown = visibility[key];
          const label = t(row.titleKey);
          return (
            <Fragment key={key}>
            <div
              className="flex min-h-[52px] items-center gap-3 border-t border-border-light py-3 first:border-t-0"
            >
              {/* Two spans, not one: the paper is the outer one and the mark the
                  inner. A mark's background is a thinned colour meant to sit on
                  top of a page — collapsed onto the same element it would replace
                  the page instead of tinting it. */}
              <span
                aria-hidden
                className="flex min-w-[88px] shrink-0 items-center justify-center rounded px-2 py-0.5 text-center text-[12px] leading-[18px]"
                style={{ backgroundColor: chipBackdrop, color: chipText }}
              >
                <span
                  style={shown
                    ? (row.mark
                      ? systemMarkCss(systemMark[row.mark], chipBackdrop)
                      : markerStyleCss(automatic, fontFamilyForMarker(automatic.font)))
                    : undefined}
                >
                  {label}
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-[13px] ${shown ? "text-text-primary" : "text-text-muted"}`}>{label}</p>
                <p className="text-[11px] leading-[17px] text-text-muted">{t(row.hintKey)}</p>
              </div>
              <Toggle
                label={label}
                checked={shown}
                onChange={(next) => onChange({ ...visibility, [key]: next })}
              />
            </div>
            {/* Indented to clear the chip column above, so it reads as a
                qualifier on the lookup row rather than a fourth mark. Hidden
                rather than disabled while lookup marks are off: there is
                nothing to keep from fading. */}
            {key === "showLookupMarkers" && shown && (
              <div className="flex min-h-[52px] items-center gap-3 border-t border-border-light py-3 pl-[100px]">
                <div className="min-w-0 flex-1">
                  <p className={`text-[13px] ${lookupNeverFade ? "text-text-primary" : "text-text-muted"}`}>
                    {t("settings.tools.markers.visibility.lookupNeverFade")}
                  </p>
                  <p className="text-[11px] leading-[17px] text-text-muted">
                    {t("settings.tools.markers.visibility.lookupNeverFadeHint")}
                  </p>
                </div>
                <Toggle
                  label={t("settings.tools.markers.visibility.lookupNeverFade")}
                  checked={lookupNeverFade}
                  onChange={onLookupNeverFadeChange}
                />
              </div>
            )}
            </Fragment>
          );
        })}
      </div>

      {/* Not a warning, and deliberately not wearing the warning icon: nothing
          is lost or at risk here. It exists because a clean page looks exactly
          like a page that stopped recording. */}
      {summary.state === "none" && (
        <div role="status" className="mt-2 flex items-start gap-2 rounded-md border border-accent/25 bg-accent-bg px-3 py-2.5">
          <Info size={14} className="mt-0.5 shrink-0 text-accent-text" />
          <p className="min-w-0 text-[11px] leading-[17px] text-text-secondary">
            {t("settings.tools.markers.visibility.allHidden")}
          </p>
        </div>
      )}
    </div>
  );
}

export default function MarkerStyleSettings({
  value,
  onChange,
  lookupRow,
  visibility,
  onVisibilityChange,
  lookupNeverFade,
  onLookupNeverFadeChange,
}: MarkerStyleSettingsProps) {
  const { t } = useTranslation();
  const [customFonts, setCustomFonts] = useState<CustomFontRecord[]>([]);
  const [wordFormsOpen, setWordFormsOpen] = useState(true);
  const [editing, setEditing] = useState<EditTarget>("manual");

  useEffect(() => {
    invoke<CustomFontRecord[]>("list_custom_fonts").then((records) => {
      setCustomFonts(records);
      installCustomFontFaces(records);
    }).catch(() => {});
  }, []);

  const automatic = effectiveAutomaticMarkerStyle(value);
  // The automatic style has nothing of its own to edit while it is copying the
  // manual one, so the controls step aside for the toggle that says so.
  const editable = editing === "manual" || !value.automaticFollowsManual;
  const edited = editing === "manual" ? value.manual : value.automatic;
  const applyEdit = (style: MarkerVisualStyle) => onChange(
    editing === "manual" ? { ...value, manual: style } : { ...value, automatic: style },
  );

  // Per pane, not once: a wash blends into the page it lands on, so the two
  // samples do not draw the read-aloud mark the same way.
  //
  // A switched-off mark hands back no style at all, which is what the book does
  // with it too: the word is drawn as the plain text it would be. The read-aloud
  // wash and the manual mark are not vocabulary marks and have no switch.
  const sampleStyles = (backdrop: string): Record<string, CSSProperties | undefined> => ({
    manual: markerStyleCss(value.manual, fontFamilyForMarker(value.manual.font)),
    automatic: visibility.showLookupMarkers
      ? markerStyleCss(automatic, fontFamilyForMarker(automatic.font))
      : undefined,
    reading: systemMarkCss(systemMark.reading, backdrop),
    vocabNew: visibility.showNewVocabMarkers ? systemMarkCss(systemMark.vocabNew, backdrop) : undefined,
    learning: visibility.showLearningMarkers ? systemMarkCss(systemMark.learning, backdrop) : undefined,
    // Same switch as `learning`, one tier further along: both are words still
    // being worked on. A mastered word is absent from the sample entirely — it
    // has no mark to demonstrate.
    familiar: visibility.showLearningMarkers ? systemMarkCss(systemMark.familiar, backdrop) : undefined,
  });

  return (
    <div className="mx-auto w-full max-w-[620px]">
      {/* Stays put while the controls scroll under it, so a colour never has to
          be chosen from memory. The negative margin reaches into the modal's
          own padding — without it the page shows through either side. */}
      <div className="sticky top-0 z-10 -mx-6 bg-white px-6 pb-3 dark:bg-bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5">
          <div role="tablist" aria-label={t("settings.tools.markers.editing")} className="inline-flex rounded-md border border-border bg-bg-input p-0.5">
            {(["manual", "automatic"] as EditTarget[]).map((target) => (
              <button
                key={target}
                type="button"
                role="tab"
                aria-selected={editing === target}
                onClick={() => setEditing(target)}
                className={`h-7 rounded-[5px] px-3 text-[11px] font-medium transition-colors ${
                  editing === target ? "bg-bg-surface text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"
                }`}
              >
                {t(`settings.tools.markers.edit${target[0].toUpperCase()}${target.slice(1)}`)}
              </button>
            ))}
          </div>
          {editable && (
            // `ml-auto` rather than the row's `justify-between` alone: once the
            // row wraps, a lone item on the second line would sit left.
            <div className="ml-auto flex items-center gap-2.5">
              <OpacityField
                value={edited.opacity}
                label={t("settings.tools.markers.opacity")}
                onChange={(opacity) => applyEdit({ ...edited, opacity })}
              />
              <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
              <div className="flex items-center gap-2">
                <ColorSwatches
                  color={edited.color}
                  presets={MARKER_COLOR_PRESETS}
                  onSelect={(color) => applyEdit({ ...edited, color })}
                />
                <CustomColorButton color={edited.color} onChange={(color) => applyEdit({ ...edited, color })} />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-2 rounded-md border border-border-light p-2 sm:grid-cols-2">
          <SamplePane theme="paper" buildStyles={sampleStyles} />
          <SamplePane theme="dark" buildStyles={sampleStyles} />
        </div>
      </div>

      {/* Outside the tabs on purpose: the complaint is about the pair, so it
          belongs to neither of the two styles being edited, and hiding it behind
          a tab would hide it from whichever one the reader is not on. */}
      {configuredMarksLookAlike(value) && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-md border border-accent/25 bg-accent-bg px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent-text" />
          <p className="min-w-0 text-[11px] leading-[17px] text-text-secondary">{t("settings.tools.markers.pairCollision")}</p>
        </div>
      )}

      {editing === "automatic" && (
        <div className="flex min-h-[52px] items-center justify-between gap-4 border-b border-border-light py-3">
          <div>
            <p className="text-[13px] font-medium text-text-primary">{t("settings.tools.markers.automaticFollowsManual")}</p>
            <p className="text-[11px] leading-[17px] text-text-muted">{t("settings.tools.markers.automaticFollowsManualHint")}</p>
          </div>
          <Toggle
            label={t("settings.tools.markers.automaticFollowsManual")}
            checked={value.automaticFollowsManual}
            onChange={(automaticFollowsManual) => onChange({ ...value, automaticFollowsManual })}
          />
        </div>
      )}

      {editable && <StyleControls value={edited} onChange={applyEdit} />}

      {customFonts.length === 0 && (
        <p className="border-t border-border-light py-3 text-[10px] leading-4 text-text-muted">
          {t("settings.tools.markers.customFontHint")}
        </p>
      )}

      <div className="flex min-h-[52px] items-center justify-between gap-4 border-t border-border-light py-3">
        <div>
          <p className="text-[13px] font-medium text-text-primary">{t("settings.tools.markers.layoutAffecting")}</p>
          <p className="text-[11px] leading-[17px] text-text-muted">{t("settings.tools.markers.layoutAffectingHint")}</p>
        </div>
        <Toggle
          label={t("settings.tools.markers.layoutAffecting")}
          checked={value.layoutAffectingMarkers}
          onChange={(layoutAffectingMarkers) => onChange({ ...value, layoutAffectingMarkers })}
        />
      </div>

      {/* The tools panel's rows carry their own 4px gutter; the marker rows do
          not, so it is pulled back to keep one edge down the group. */}
      {lookupRow && (
        <div className="border-t border-border-light py-1.5">
          <div className="-mx-1">{lookupRow}</div>
        </div>
      )}

      {/* Directly under the lookup switch, which is the other question about
          when a mark appears at all rather than what it looks like — and still
          above the word-form list, which is long enough to bury anything after
          it. */}
      <VisibilitySection
        visibility={visibility}
        automatic={automatic}
        onChange={onVisibilityChange}
        lookupNeverFade={lookupNeverFade}
        onLookupNeverFadeChange={onLookupNeverFadeChange}
      />

      {/* Last: the word-form list can run long and scrolls on its own, so
          nothing that needs finding sits below it. */}
      <div className="flex min-h-[52px] items-center justify-between gap-4 border-t border-border-light py-3">
        <div className="flex min-w-0 items-start gap-1.5">
          {value.wordMatchScope === "forms" && (
            <button
              type="button"
              aria-expanded={wordFormsOpen}
              onClick={() => setWordFormsOpen((open) => !open)}
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"
            >
              {wordFormsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
          <div>
            <p className="text-[13px] font-medium text-text-primary">{t("settings.tools.markers.wordScope")}</p>
            <p className="text-[11px] leading-[17px] text-text-muted">{t("settings.tools.markers.wordScopeHint")}</p>
          </div>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={value.wordMatchScope}
          onChange={(scope) => {
            if (scope === "forms") setWordFormsOpen(true);
            onChange({ ...value, wordMatchScope: scope as MarkerStyleConfig["wordMatchScope"] });
          }}
          options={[
            { value: "current", label: t("settings.tools.markers.currentOnly") },
            { value: "book", label: t("settings.tools.markers.sameWordsInBook") },
            { value: "forms", label: t("settings.tools.markers.sameWordForms") },
          ]}
        />
      </div>

      {value.wordMatchScope === "forms" && wordFormsOpen && <WordFormsManager />}
    </div>
  );
}
