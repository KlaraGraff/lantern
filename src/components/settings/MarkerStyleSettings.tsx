import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MARKER_COLOR_PRESETS,
  effectiveAutomaticMarkerStyle,
  markerStyleCss,
  type MarkerStyleConfig,
  type MarkerVisualStyle,
} from "../marker-style";
import { markBlendMode, systemMark, type SystemMark, type SystemMarkId, markCollisions } from "../mark-palette";
import { fonts, getDefaultReaderTheme, getThemeStyles } from "../reader-settings";
import { installCustomFontFaces, type CustomFontRecord } from "../custom-fonts";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import ColorControl from "../ui/ColorControl";
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
  mastered: "vocab.mastery.mastered",
};

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
      <ColorControl
        color={value.color}
        opacity={value.opacity}
        presets={[]}
        colorLabel={t("settings.tools.markers.color")}
        pickerLabel={t("settings.tools.markers.colorPicker")}
        hexLabel={t("settings.tools.markers.hexColor")}
        opacityLabel={t("settings.tools.markers.opacity")}
        onChange={(next) => onChange({ ...value, ...next })}
      />

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

export default function MarkerStyleSettings({ value, onChange, lookupRow }: MarkerStyleSettingsProps) {
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
  const sampleStyles = (backdrop: string): Record<string, CSSProperties | undefined> => ({
    manual: markerStyleCss(value.manual, fontFamilyForMarker(value.manual.font)),
    automatic: markerStyleCss(automatic, fontFamilyForMarker(automatic.font)),
    reading: systemMarkCss(systemMark.reading, backdrop),
    vocabNew: systemMarkCss(systemMark.vocabNew, backdrop),
    learning: systemMarkCss(systemMark.learning, backdrop),
    mastered: systemMarkCss(systemMark.mastered, backdrop),
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
            <ColorSwatches
              color={edited.color}
              presets={MARKER_COLOR_PRESETS}
              onSelect={(color) => applyEdit({ ...edited, color })}
            />
          )}
        </div>

        <div className="grid gap-2 rounded-md border border-border-light p-2 sm:grid-cols-2">
          <SamplePane theme="paper" buildStyles={sampleStyles} />
          <SamplePane theme="dark" buildStyles={sampleStyles} />
        </div>
      </div>

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
