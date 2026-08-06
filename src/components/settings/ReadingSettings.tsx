import { useCallback, useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Download, RotateCcw, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import ColorControl from "../ui/ColorControl";
import {
  customFontFamily,
  fonts,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  getDefaultReaderTheme,
  parseReaderCustomTheme,
  getCustomThemeStyles,
  type ReaderCustomTheme,
  type ReaderTheme,
} from "../reader-settings";
import { loadCustomFonts, type CustomFontRecord } from "../custom-fonts";
import { notifyReadingAssistanceSettingsChanged } from "../reading-assistance-events";
import { ROW_CONTROL_WIDTH, type SettingsProps } from "./types";
import { platform } from "../../services/platform";
import {
  PageTurnBindingButton,
  type BindingDirection,
  type PageTurnAnimation,
  type ParagraphSpacing,
  type ReadingMode,
} from "../ReaderSettings";
import { DEFAULT_NEXT_PAGE_BINDING, DEFAULT_PREVIOUS_PAGE_BINDING } from "../reader-bindings";
import PassiveVocabSettings from "./PassiveVocabSettings";
import type { PassiveVocabPreviewState } from "./PassiveVocabPreview";
import { formatPassiveVocabSummary, parsePassiveVocabSettings } from "../passive-vocab";
import type { SettingsView } from "../settings-destination";
import EnhancedFontSettings from "./EnhancedFontSettings";
import Button from "../ui/Button";
import ConfirmDialog from "./ConfirmDialog";
import { buildReadingDefaultSettings } from "./reading-defaults";
import { createDefaultReaderSettings } from "../../pages/reader/useReaderSettingsSync";
import {
  addPendingWrites,
  appliedSnapshot,
  groupsToRehydrate,
  rehydrationKeys,
  removePendingWrites,
} from "./settings-rehydration";
import {
  groupsHoldingUncommittedNumber,
  READING_REHYDRATION_GROUPS,
  READING_REHYDRATION_KEYS,
} from "./reading-rehydration";

const READER_THEME_OPTIONS: {
  value: ReaderTheme;
  labelKey: string;
  swatchClass: string;
  checkClass: string;
}[] = [
  {
    value: "original",
    labelKey: "readerSettings.themeOriginal",
    swatchClass: "bg-reader-original-bg border border-reader-original-border",
    checkClass: "text-accent",
  },
  {
    value: "paper",
    labelKey: "readerSettings.themeSepia",
    swatchClass: "bg-reader-paper-bg",
    checkClass: "text-accent",
  },
  {
    value: "quiet",
    labelKey: "readerSettings.themeGray",
    swatchClass: "bg-reader-quiet-bg",
    checkClass: "text-white",
  },
  {
    value: "dark",
    labelKey: "readerSettings.themeDark",
    swatchClass: "bg-reader-dark-bg border border-reader-dark-border",
    checkClass: "text-white",
  },
  {
    value: "custom",
    labelKey: "readerSettings.themeCustom",
    swatchClass: "border border-reader-original-border",
    checkClass: "text-accent",
  },
];

const CUSTOM_THEME_PRESETS = ["#F4E6C7", "#DDE8D8", "#DDE7F1", "#E7DDEC", "#D8D9DC"] as const;

// The input keeps no draft of its own: each keystroke goes straight into the
// caller's state, and nothing is written until `onBlur` (Enter blurs too). That
// is why the caller has to know when one of these has focus — see
// `reading-rehydration.ts`.
function NumberInput({ value, onChange, onFocus, onBlur, suffix, min, max }: {
  value: number;
  onChange: (v: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0 w-[90px] justify-end">
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (min !== undefined && v < min) return;
          if (max !== undefined && v > max) return;
          onChange(v);
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-[64px] h-8 bg-white dark:bg-bg-surface rounded-[10px] px-2 text-[13px] font-medium text-text-secondary text-center outline-none border border-border focus:border-accent transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[12px] text-text-muted w-[16px] text-left">{suffix}</span>
    </div>
  );
}

/** The section shows either its own list or the vocabulary-assist sub-page. */
type ReadingView = "list" | "passiveVocab";

interface ReadingSettingsProps extends SettingsProps {
  /** A deep link can land straight on the vocabulary-assist sub-page. */
  initialView?: SettingsView;
  onPassiveVocabPreviewChange?: (preview: PassiveVocabPreviewState | null) => void;
  /**
   * Reports the way out of a sub-page, so Escape can leave the sub-page before
   * it closes the whole modal. Null while the section shows its own list.
   */
  onSubPageChange?: (back: (() => void) | null) => void;
}

export default function ReadingSettings({
  settings,
  loading,
  refresh,
  save,
  saveBulk,
  showSavedToast,
  initialView,
  onPassiveVocabPreviewChange,
  onSubPageChange,
}: ReadingSettingsProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<ReadingView>(initialView === "passiveVocab" ? "passiveVocab" : "list");
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(getDefaultReaderTheme());
  const [customTheme, setCustomTheme] = useState<ReaderCustomTheme>(() => parseReaderCustomTheme(null));
  const [fontFamily, setFontFamily] = useState("georgia");
  const [fontSize, setFontSize] = useState(26);
  const [narrowFontShrink, setNarrowFontShrink] = useState(true);
  const [lineSpacing, setLineSpacing] = useState(1.8);
  const [charSpacing, setCharSpacing] = useState(0);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [textJustification, setTextJustification] = useState(false);
  const [paragraphSpacing, setParagraphSpacing] = useState<ParagraphSpacing>("original");
  const [firstLineIndent, setFirstLineIndent] = useState(false);
  // Same default as `createDefaultReaderSettings()` — read from there instead
  // of a second hard-coded number, so the pre-hydration row and the reader's
  // own default cannot drift apart.
  const [margins, setMargins] = useState(() => createDefaultReaderSettings().margins);
  const [readingMode, setReadingMode] = useState<ReadingMode>("scrolling");
  const [pageLayout, setPageLayout] = useState<"1" | "2">("2");
  const [pageTurnAnimation, setPageTurnAnimation] = useState<PageTurnAnimation>("slide");
  const [showChapterProgress, setShowChapterProgress] = useState(true);
  const [showBookProgress, setShowBookProgress] = useState(false);
  const [showPageNumbers, setShowPageNumbers] = useState(false);
  const [previousPageBinding, setPreviousPageBinding] = useState(DEFAULT_PREVIOUS_PAGE_BINDING);
  const [nextPageBinding, setNextPageBinding] = useState(DEFAULT_NEXT_PAGE_BINDING);
  const [capturingBinding, setCapturingBinding] = useState<BindingDirection | null>(null);
  const [customFonts, setCustomFonts] = useState<CustomFontRecord[]>([]);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // What the rows on screen were built from, and which keys this pane is
  // writing right now. Together they tell an outside change apart from the
  // pane's own — only the first may replace a control the user can see.
  const hydratedRef = useRef(false);
  const appliedRef = useRef<Record<string, string | undefined>>({});
  const pendingWritesRef = useRef(new Map<string, number>());
  // The number row the caret is in, if any. Held as state, not a ref, because
  // losing focus is one of the two events that let a held-back group through.
  const [focusedNumberKey, setFocusedNumberKey] = useState<string | null>(null);
  // The other one: a write of this pane's own settling. Nothing else would
  // re-run the effect below afterwards, so a change that arrived from outside
  // while the write was in flight would sit unread until the next one.
  const [writesSettled, setWritesSettled] = useState(0);

  const fontOptions = [
    ...fonts.filter((font) => font.group === "system").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupSystem") })),
    ...fonts.filter((font) => font.group === "built-in").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupBuiltIn") })),
    ...fonts.filter((font) => font.group === "custom").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupMine") })),
  ];

  /**
   * One block of rows read out of the settings map. The first pass asks for
   * every group; after that only the groups an outside change actually moved
   * come through here, so a control the user is working in is left alone.
   */
  const applyGroups = useCallback((ids: readonly string[], values: Record<string, string>) => {
    for (const id of ids) {
      switch (id) {
        case "theme":
          setReaderTheme((values.reader_theme as ReaderTheme) || getDefaultReaderTheme());
          setCustomTheme(parseReaderCustomTheme(values.reader_custom_theme));
          break;
        case "fontFamily":
          if (values.font_family) setFontFamily(values.font_family);
          break;
        case "fontSize":
          if (values.font_size) setFontSize(parseInt(values.font_size));
          break;
        case "narrowFontShrink":
          setNarrowFontShrink(values.narrow_font_shrink !== "false");
          break;
        case "lineSpacing":
          if (values.line_spacing) setLineSpacing(parseFloat(values.line_spacing));
          break;
        case "charSpacing":
          if (values.char_spacing) setCharSpacing(parseInt(values.char_spacing));
          break;
        case "wordSpacing":
          if (values.word_spacing) setWordSpacing(parseInt(values.word_spacing));
          break;
        case "paragraph":
          setTextJustification(values.text_justification === "true");
          if (["original", "none", "compact", "comfortable", "loose"].includes(values.paragraph_spacing)) {
            setParagraphSpacing(values.paragraph_spacing as ParagraphSpacing);
          }
          setFirstLineIndent(values.first_line_indent === "true");
          break;
        case "margins":
          if (values.margins) setMargins(parseInt(values.margins));
          break;
        case "pageFlow":
          if (values.reading_mode === "paginated" || values.reading_mode === "scrolling") {
            setReadingMode(values.reading_mode);
          }
          if (values.page_columns === "1" || values.page_columns === "2") {
            setPageLayout(values.page_columns);
          }
          if (
            values.page_turn_animation === "none"
            || values.page_turn_animation === "slide"
            || values.page_turn_animation === "fade"
            || values.page_turn_animation === "cover"
          ) {
            setPageTurnAnimation(values.page_turn_animation);
          }
          break;
        case "progress":
          if (values.show_chapter_progress !== undefined) {
            setShowChapterProgress(values.show_chapter_progress !== "false");
          }
          if (values.show_book_progress !== undefined) {
            setShowBookProgress(values.show_book_progress === "true");
          }
          if (values.show_page_numbers !== undefined) {
            setShowPageNumbers(values.show_page_numbers === "true");
          }
          break;
        case "bindings":
          if (values.previous_page_binding) setPreviousPageBinding(values.previous_page_binding);
          if (values.next_page_binding) setNextPageBinding(values.next_page_binding);
          break;
      }
    }
  }, []);

  useEffect(() => {
    if (loading || hydratedRef.current) return;
    applyGroups(READING_REHYDRATION_GROUPS.map((group) => group.id), settings);
    appliedRef.current = appliedSnapshot(READING_REHYDRATION_KEYS, settings);
    hydratedRef.current = true;
  }, [applyGroups, loading, settings]);

  // Reading on from there: the modal outlives the values it is showing. On the
  // desktop the reader is a window of its own, so anything it writes — 「设为
  // 全局默认」 above all — arrives here as a settings change while this pane is
  // open, and the rows have to follow it.
  //
  // What they must not follow is the pane's own echo, or a change that lands
  // mid-keystroke. The first is handled by recording every write as applied at
  // the moment it goes out; the second by holding back the one group whose
  // number input currently holds digits nobody has committed.
  useEffect(() => {
    if (loading || !hydratedRef.current) return;
    const stale = groupsToRehydrate({
      groups: READING_REHYDRATION_GROUPS,
      stored: settings,
      applied: appliedRef.current,
      pending: pendingWritesRef.current.keys(),
      blocked: groupsHoldingUncommittedNumber({
        focusedKey: focusedNumberKey,
        values: {
          font_size: String(fontSize),
          line_spacing: String(lineSpacing),
          char_spacing: String(charSpacing),
          word_spacing: String(wordSpacing),
          margins: String(margins),
        },
        applied: appliedRef.current,
      }),
    });
    if (stale.length === 0) return;
    applyGroups(stale, settings);
    appliedRef.current = {
      ...appliedRef.current,
      ...appliedSnapshot(rehydrationKeys(READING_REHYDRATION_GROUPS, stale), settings),
    };
  }, [
    applyGroups,
    charSpacing,
    focusedNumberKey,
    fontSize,
    lineSpacing,
    loading,
    margins,
    settings,
    wordSpacing,
    writesSettled,
  ]);

  /**
   * Every write this pane makes. The keys are claimed before the write starts
   * and released once it has settled, so the echo coming back cannot be mistaken
   * for someone else's change — and `writesSettled` gives the effect above the
   * re-run it needs to pick up anything that did arrive meanwhile.
   *
   * `repaint` is for the write whose whole point is to move rows the user is not
   * touching (restore defaults). Recording those as already applied would
   * explain the echo away and leave every row showing its old value.
   */
  const persist = useCallback((entries: Record<string, string>, options?: { repaint?: boolean }) => {
    const keys = Object.keys(entries);
    addPendingWrites(pendingWritesRef.current, keys);
    if (!options?.repaint) appliedRef.current = { ...appliedRef.current, ...entries };
    return saveBulk(entries)
      .then(() => true)
      .catch((error) => {
        console.error("Failed to save reading settings:", error);
        return false;
      })
      .finally(() => {
        removePendingWrites(pendingWritesRef.current, keys);
        setWritesSettled((count) => count + 1);
      });
  }, [saveBulk]);

  // One write for all twenty rows, and deliberately not recorded as applied:
  // `saveBulk` pushes the new values back into `settings`, and the effect above
  // repaints every group at once instead of the section flickering key by key.
  const restoreReadingDefaults = useCallback(async () => {
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const saved = await persist(
        buildReadingDefaultSettings(createDefaultReaderSettings()),
        { repaint: true },
      );
      // The dialog closes either way: a failure message belongs next to the row
      // that still says 「恢复默认」, and a modal left open over the page hides the
      // very settings the user is being told did not change.
      setRestoreConfirm(false);
      if (saved) showSavedToast();
      else setRestoreError(t("settings.layout.restoreDefaultsFailed"));
    } finally {
      setRestoreBusy(false);
    }
  }, [persist, showSavedToast, t]);

  // A number row commits on blur and only on blur (Enter blurs it), so blur is
  // also where the hold on its group is lifted: by then the digits are on their
  // way to the store and recorded as applied, and the same render that clears
  // the focus re-runs the effect above.
  const numberRow = (key: string, value: number) => ({
    onFocus: () => setFocusedNumberKey(key),
    onBlur: () => {
      setFocusedNumberKey(null);
      void persist({ [key]: String(value) });
    },
  });

  const refreshCustomFonts = useCallback(async () => {
    const records = await loadCustomFonts();
    setCustomFonts(records);
    return records;
  }, []);

  const selectedCustomFontIsMissing = (records: CustomFontRecord[]) => (
    fontFamily.startsWith("custom-")
    && !records.some((record) => record.id === fontFamily)
  );

  useEffect(() => {
    if (loading) return;
    refreshCustomFonts().catch((error) => console.error("Failed to load custom fonts:", error));
  }, [loading, refreshCustomFonts]);

  useEffect(() => {
    if (initialView === "passiveVocab") setView("passiveVocab");
  }, [initialView]);

  useEffect(() => {
    onSubPageChange?.(view === "passiveVocab" ? () => setView("list") : null);
  }, [onSubPageChange, view]);

  useEffect(() => () => onSubPageChange?.(null), [onSubPageChange]);

  if (view === "passiveVocab") {
    return (
      <PassiveVocabSettings
        settings={settings}
        loading={loading}
        refresh={refresh}
        save={save}
        saveBulk={saveBulk}
        showSavedToast={showSavedToast}
        onBack={() => setView("list")}
        onPreviewChange={onPassiveVocabPreviewChange}
      />
    );
  }

  return (
    <div>
      {/* Theme */}
      <div className="flex items-center justify-between min-h-[88px] py-2">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.theme")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.themeHint")}</p>
        </div>
        <div className="grid grid-cols-5 gap-2 shrink-0">
          {READER_THEME_OPTIONS.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => {
                setReaderTheme(theme.value);
                void persist({ reader_theme: theme.value });
                showSavedToast();
              }}
              className="w-[48px] flex flex-col items-center gap-1.5 cursor-pointer"
            >
              <span
                className={`size-8 rounded-full ${theme.swatchClass} flex items-center justify-center ${
                  readerTheme === theme.value ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""
                }`}
                style={theme.value === "custom" ? { backgroundColor: getCustomThemeStyles(customTheme).body } : undefined}
              >
                {readerTheme === theme.value && <Check size={14} className={theme.checkClass} />}
              </span>
              <span className="text-[10px] font-medium text-text-muted leading-none">{t(theme.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>
      {readerTheme === "custom" && (
        <div className="border-b border-border-light pb-4">
          <ColorControl
            color={customTheme.color}
            opacity={customTheme.opacity}
            minOpacity={0}
            presets={CUSTOM_THEME_PRESETS}
            colorLabel={t("settings.layout.customThemeColor")}
            pickerLabel={t("settings.layout.customThemePicker")}
            hexLabel={t("settings.layout.customThemeHex")}
            opacityLabel={t("settings.layout.customThemeOpacity")}
            onChange={(next) => {
              setCustomTheme(next);
              void persist({
                reader_theme: "custom",
                reader_custom_theme: JSON.stringify(next),
              }).then((saved) => { if (saved) showSavedToast(); });
            }}
          />
        </div>
      )}
      {/* Font Family */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontFamily")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontFamilyHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={fontFamily}
          onChange={(v) => { setFontFamily(v); void persist({ font_family: v }); showSavedToast(); }}
          options={fontOptions}
        />
      </div>
      <EnhancedFontSettings />
      {/* Importing needs a native file picker. Without one there is no way to
          put a font here, so the whole group goes rather than leaving a list
          that can only ever be empty. Fonts already chosen stay selectable in
          the Font Family list above either way. */}
      {platform.hasFontImport && (
        <div className="border-t border-border-light py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-text-primary">{t("settings.layout.customFonts")}</p>
              <p className="mt-0.5 text-[11px] leading-[17px] text-text-muted">{t("settings.layout.customFontsHint")}</p>
            </div>
            <button
              type="button"
              disabled={fontBusy}
              onClick={async () => {
                setFontBusy(true);
                setFontError(null);
                try {
                  await invoke<CustomFontRecord[]>("import_custom_fonts");
                  await refreshCustomFonts();
                  showSavedToast();
                } catch (error) {
                  console.error("Failed to import fonts:", error);
                  setFontError(t("settings.layout.fontImportFailed"));
                } finally {
                  setFontBusy(false);
                }
              }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium text-text-secondary hover:bg-bg-input disabled:opacity-50"
            >
              <Download size={13} />
              {t("settings.layout.importFonts")}
            </button>
          </div>
          {customFonts.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {customFonts.map((font) => (
                <div key={font.id} className="flex min-h-9 items-center justify-between gap-3 rounded-md bg-bg-input px-3">
                  <span className="min-w-0 truncate text-[12px] text-text-primary" style={{ fontFamily: customFontFamily(font.id) }}>
                    {font.family_name}
                  </span>
                  <button
                    type="button"
                    title={t("settings.layout.deleteFont")}
                    aria-label={t("settings.layout.deleteFont")}
                    disabled={fontBusy}
                    onClick={async () => {
                      setFontBusy(true);
                      setFontError(null);
                      try {
                        await invoke("delete_custom_font", { id: font.id });
                        const records = await refreshCustomFonts();
                        if (selectedCustomFontIsMissing(records)) setFontFamily("system");
                        await refresh();
                        await notifyReadingAssistanceSettingsChanged([
                          "font_family",
                          "marker_style_config",
                        ]);
                        showSavedToast();
                      } catch (error) {
                        console.error("Failed to delete font:", error);
                        // Re-read the backend after any failure. This also heals
                        // the UI when an older backend reports an error after
                        // already deleting its database row.
                        const records = await refreshCustomFonts().catch(() => null);
                        await refresh().catch(() => {});
                        if (records && selectedCustomFontIsMissing(records)) {
                          setFontFamily("system");
                          await notifyReadingAssistanceSettingsChanged([
                            "font_family",
                            "marker_style_config",
                          ]).catch(() => {});
                        }
                        setFontError(t("settings.layout.fontDeleteFailed"));
                      } finally {
                        setFontBusy(false);
                      }
                    }}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-danger-text disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {fontError && (
            <p role="alert" className="mt-2 text-[11px] leading-4 text-danger-text">
              {fontError}
            </p>
          )}
        </div>
      )}
      {/* Font Size */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontSize")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontSizeHint")}</p>
        </div>
        <NumberInput value={fontSize} onChange={setFontSize} {...numberRow("font_size", fontSize)} suffix="px" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} />
      </div>
      {/* Shrink the font on narrow windows */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.narrowFontShrink")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.narrowFontShrinkHint")}</p>
        </div>
        <Toggle
          label={t("settings.layout.narrowFontShrink")}
          checked={narrowFontShrink}
          onChange={(v) => {
            setNarrowFontShrink(v);
            void persist({ narrow_font_shrink: String(v) });
            showSavedToast();
          }}
        />
      </div>
      {/* Line Spacing */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.lineSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.lineSpacingHint")}</p>
        </div>
        <NumberInput value={lineSpacing} onChange={setLineSpacing} {...numberRow("line_spacing", lineSpacing)} suffix="x" min={1} max={3} />
      </div>
      {/* Character Spacing */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.charSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.charSpacingHint")}</p>
        </div>
        <NumberInput value={charSpacing} onChange={setCharSpacing} {...numberRow("char_spacing", charSpacing)} suffix="%" min={-5} max={20} />
      </div>
      {/* Word Spacing */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.wordSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.wordSpacingHint")}</p>
        </div>
        <NumberInput value={wordSpacing} onChange={setWordSpacing} {...numberRow("word_spacing", wordSpacing)} suffix="%" min={-10} max={50} />
      </div>
      {/* Margins */}
      <div className="border-y border-border-light py-4">
        <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.paragraph")}</p>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-[14px] font-medium text-text-primary">{t("settings.layout.justify")}</p>
            <p className="mt-0.5 text-[12px] text-text-muted">{t("settings.layout.justifyHint")}</p>
          </div>
          <Toggle label={t("settings.layout.justify")} checked={textJustification} onChange={(value) => {
            setTextJustification(value); void persist({ text_justification: String(value) }); showSavedToast();
          }} />
        </div>
        <div className="mt-3">
          <p className="text-[14px] font-medium text-text-primary">{t("settings.layout.paragraphSpacing")}</p>
          <div className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-bg-input p-1" role="group" aria-label={t("settings.layout.paragraphSpacing")}>
            {(["none", "compact", "comfortable", "loose"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={paragraphSpacing === value} onClick={() => {
                setParagraphSpacing(value); void persist({ paragraph_spacing: value }); showSavedToast();
              }} className={`h-8 rounded-md text-[12px] ${paragraphSpacing === value ? "bg-bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}>
                {t(`readerSettings.paragraphSpacing.${value}`)}
              </button>
            ))}
          </div>
          {paragraphSpacing === "original" && <p className="mt-1.5 text-[12px] text-text-muted">{t("settings.layout.publisherDefault")}</p>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-[14px] font-medium text-text-primary">{t("settings.layout.firstLineIndent")}</p>
            <p className="mt-0.5 text-[12px] text-text-muted">{t("settings.layout.firstLineIndentHint")}</p>
          </div>
          <Toggle label={t("settings.layout.firstLineIndent")} checked={firstLineIndent} onChange={(value) => {
            setFirstLineIndent(value); void persist({ first_line_indent: String(value) }); showSavedToast();
          }} />
        </div>
      </div>
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.margins")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.marginsHint")}</p>
        </div>
        <NumberInput value={margins} onChange={setMargins} {...numberRow("margins", margins)} suffix="%" min={0} max={30} />
      </div>
      {/* Default Page Flow */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.readingMode")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.readingModeHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={readingMode}
          onChange={(value) => {
            const next = value as ReadingMode;
            setReadingMode(next);
            void persist({ reading_mode: next });
            showSavedToast();
          }}
          options={[
            { value: "scrolling", label: t("readerSettings.scrolling") },
            { value: "paginated", label: t("readerSettings.pageTurning") },
          ]}
        />
      </div>
      {/* Default Page Layout */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.pageLayout")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.pageLayoutHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={pageLayout}
          onChange={(value) => {
            const next = value as "1" | "2";
            setPageLayout(next);
            void persist({ page_columns: next });
            showSavedToast();
          }}
          options={[
            { value: "1", label: t("readerSettings.singlePage") },
            { value: "2", label: t("readerSettings.twoPages") },
          ]}
        />
      </div>
      {/* Page-turn Animation */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.pageTurnAnimation")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.pageTurnAnimationHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={pageTurnAnimation}
          onChange={(value) => {
            const next = value as PageTurnAnimation;
            setPageTurnAnimation(next);
            void persist({ page_turn_animation: next });
            showSavedToast();
          }}
          options={[
            { value: "slide", label: t("readerSettings.animationSlide") },
            { value: "fade", label: t("readerSettings.animationFade") },
            { value: "cover", label: t("readerSettings.animationCover") },
            { value: "none", label: t("readerSettings.animationNone") },
          ]}
        />
      </div>
      {/* Progress Display */}
      <div className="flex items-center justify-between min-h-[73px] py-3 gap-4">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.progressDisplay")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.progressDisplayHint")}</p>
        </div>
        <div className={`flex flex-col gap-2 ${ROW_CONTROL_WIDTH}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-text-secondary">{t("readerSettings.chapterProgressAlways")}</span>
            <Toggle
              label={t("readerSettings.chapterProgressAlways")}
              checked={showChapterProgress}
              onChange={(v) => {
                setShowChapterProgress(v);
                void persist({ show_chapter_progress: String(v) });
                showSavedToast();
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-text-secondary">{t("readerSettings.bookProgress")}</span>
            <Toggle
              label={t("readerSettings.bookProgress")}
              checked={showBookProgress}
              onChange={(v) => {
                setShowBookProgress(v);
                void persist({ show_book_progress: String(v) });
                showSavedToast();
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-text-secondary">{t("readerSettings.pageNumbers")}</span>
            <Toggle
              label={t("readerSettings.pageNumbers")}
              checked={showPageNumbers}
              onChange={(v) => {
                setShowPageNumbers(v);
                void persist({ show_page_numbers: String(v) });
                showSavedToast();
              }}
            />
          </div>
        </div>
      </div>
      {/* Previous-page Control */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.previousPageBinding")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("readerSettings.pageTurnBindingsHint")}</p>
        </div>
        <PageTurnBindingButton
          direction="previous"
          value={previousPageBinding}
          active={capturingBinding === "previous"}
          onActivate={setCapturingBinding}
          onChange={(value) => {
            const swapsNext = value === nextPageBinding;
            const previous = previousPageBinding;
            setPreviousPageBinding(value);
            if (swapsNext) setNextPageBinding(previous);
            void persist(
              swapsNext
                ? { previous_page_binding: value, next_page_binding: previous }
                : { previous_page_binding: value },
            ).then((saved) => { if (saved) showSavedToast(); });
          }}
        />
      </div>
      {/* Next-page Control */}
      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.nextPageBinding")}</p>
        </div>
        <PageTurnBindingButton
          direction="next"
          value={nextPageBinding}
          active={capturingBinding === "next"}
          onActivate={setCapturingBinding}
          onChange={(value) => {
            const swapsPrevious = value === previousPageBinding;
            const previous = nextPageBinding;
            setNextPageBinding(value);
            if (swapsPrevious) setPreviousPageBinding(previous);
            void persist(
              swapsPrevious
                ? { next_page_binding: value, previous_page_binding: previous }
                : { next_page_binding: value },
            ).then((saved) => { if (saved) showSavedToast(); });
          }}
        />
      </div>
      {/* Vocabulary assist has a sub-page of its own — style, density and a
          live preview do not fit a single row. */}
      <button
        type="button"
        onClick={() => setView("passiveVocab")}
        className="group flex min-h-[73px] py-3 w-full items-center justify-between gap-4 border-t border-border-light text-left"
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.passiveVocab.title")}</span>
          <span className="mt-0.5 block truncate text-[12px] text-text-muted">
            {formatPassiveVocabSummary(parsePassiveVocabSettings(settings), (key) => t(key))}
          </span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-text-muted group-hover:text-text-primary" />
      </button>
      {/* Restore defaults — last row, because it undoes every row above it. */}
      <div className="border-t border-border-light">
        <div className="flex items-center justify-between min-h-[73px] py-3">
          <div>
            <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.restoreDefaults")}</p>
            <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.restoreDefaultsHint")}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => { setRestoreError(null); setRestoreConfirm(true); }}>
            <RotateCcw size={13} />
            {t("settings.layout.restoreDefaultsAction")}
          </Button>
        </div>
        {restoreError && (
          <p role="alert" className="-mt-1 pb-3 text-[12px] leading-[18px] text-danger-text">
            {restoreError}
          </p>
        )}
      </div>
      {restoreConfirm && (
        <ConfirmDialog
          title={t("settings.layout.restoreDefaultsConfirmTitle")}
          description={t("settings.layout.restoreDefaultsConfirmBody")}
          primaryLabel={t("settings.layout.restoreDefaultsAction")}
          primaryDisabled={restoreBusy}
          onPrimary={() => { void restoreReadingDefaults(); }}
          secondaryLabel={t("common.cancel")}
          onSecondary={() => { if (!restoreBusy) setRestoreConfirm(false); }}
        />
      )}
    </div>
  );
}
