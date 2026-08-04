import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Trash2 } from "lucide-react";
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
import { DEFAULT_NEXT_PAGE_BINDING, DEFAULT_PREVIOUS_PAGE_BINDING } from "../page-turn-bindings";

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

function NumberInput({ value, onChange, onBlur, suffix, min, max }: {
  value: number;
  onChange: (v: number) => void;
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
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-[64px] h-8 bg-white dark:bg-bg-surface rounded-[10px] px-2 text-[13px] font-medium text-text-secondary text-center outline-none border border-border focus:border-accent transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[12px] text-text-muted w-[16px] text-left">{suffix}</span>
    </div>
  );
}

export default function ReadingSettings({ settings, loading, refresh, save, saveBulk, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
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
  const [margins, setMargins] = useState(0);
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

  const fontOptions = [
    ...fonts.filter((font) => font.group === "system").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupSystem") })),
    ...fonts.filter((font) => font.group === "built-in").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupBuiltIn") })),
    ...fonts.filter((font) => font.group === "custom").map((font) => ({ value: font.id, label: font.label, group: t("settings.layout.fontGroupMine") })),
  ];

  useEffect(() => {
    if (loading) return;
    setReaderTheme((settings.reader_theme as ReaderTheme) || getDefaultReaderTheme());
    setCustomTheme(parseReaderCustomTheme(settings.reader_custom_theme));
    if (settings.font_family) setFontFamily(settings.font_family);
    if (settings.font_size) setFontSize(parseInt(settings.font_size));
    setNarrowFontShrink(settings.narrow_font_shrink !== "false");
    if (settings.line_spacing) setLineSpacing(parseFloat(settings.line_spacing));
    if (settings.char_spacing) setCharSpacing(parseInt(settings.char_spacing));
    if (settings.word_spacing) setWordSpacing(parseInt(settings.word_spacing));
    setTextJustification(settings.text_justification === "true");
    if (["original", "none", "compact", "comfortable", "loose"].includes(settings.paragraph_spacing)) {
      setParagraphSpacing(settings.paragraph_spacing as ParagraphSpacing);
    }
    setFirstLineIndent(settings.first_line_indent === "true");
    if (settings.margins) setMargins(parseInt(settings.margins));
    if (settings.reading_mode === "paginated" || settings.reading_mode === "scrolling") {
      setReadingMode(settings.reading_mode);
    }
    if (settings.page_columns === "1" || settings.page_columns === "2") {
      setPageLayout(settings.page_columns);
    }
    if (
      settings.page_turn_animation === "none"
      || settings.page_turn_animation === "slide"
      || settings.page_turn_animation === "fade"
      || settings.page_turn_animation === "cover"
    ) {
      setPageTurnAnimation(settings.page_turn_animation);
    }
    if (settings.show_chapter_progress !== undefined) {
      setShowChapterProgress(settings.show_chapter_progress !== "false");
    }
    if (settings.show_book_progress !== undefined) {
      setShowBookProgress(settings.show_book_progress === "true");
    }
    if (settings.show_page_numbers !== undefined) {
      setShowPageNumbers(settings.show_page_numbers === "true");
    }
    if (settings.previous_page_binding) setPreviousPageBinding(settings.previous_page_binding);
    if (settings.next_page_binding) setNextPageBinding(settings.next_page_binding);
  }, [settings, loading]);

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
                save("reader_theme", theme.value);
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
              void saveBulk({
                reader_theme: "custom",
                reader_custom_theme: JSON.stringify(next),
              }).then(() => showSavedToast());
            }}
          />
        </div>
      )}
      {/* Font Family */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontFamily")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontFamilyHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={fontFamily}
          onChange={(v) => { setFontFamily(v); save("font_family", v); showSavedToast(); }}
          options={fontOptions}
        />
      </div>
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
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontSize")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontSizeHint")}</p>
        </div>
        <NumberInput value={fontSize} onChange={setFontSize} onBlur={() => save("font_size", String(fontSize))} suffix="px" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} />
      </div>
      {/* Shrink the font on narrow windows */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.narrowFontShrink")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.narrowFontShrinkHint")}</p>
        </div>
        <Toggle
          label={t("settings.layout.narrowFontShrink")}
          checked={narrowFontShrink}
          onChange={(v) => {
            setNarrowFontShrink(v);
            save("narrow_font_shrink", String(v));
            showSavedToast();
          }}
        />
      </div>
      {/* Line Spacing */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.lineSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.lineSpacingHint")}</p>
        </div>
        <NumberInput value={lineSpacing} onChange={setLineSpacing} onBlur={() => save("line_spacing", String(lineSpacing))} suffix="x" min={1} max={3} />
      </div>
      {/* Character Spacing */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.charSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.charSpacingHint")}</p>
        </div>
        <NumberInput value={charSpacing} onChange={setCharSpacing} onBlur={() => save("char_spacing", String(charSpacing))} suffix="%" min={-5} max={20} />
      </div>
      {/* Word Spacing */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.wordSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.wordSpacingHint")}</p>
        </div>
        <NumberInput value={wordSpacing} onChange={setWordSpacing} onBlur={() => save("word_spacing", String(wordSpacing))} suffix="%" min={-10} max={50} />
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
            setTextJustification(value); save("text_justification", String(value)); showSavedToast();
          }} />
        </div>
        <div className="mt-3">
          <p className="text-[14px] font-medium text-text-primary">{t("settings.layout.paragraphSpacing")}</p>
          <div className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-bg-input p-1" role="group" aria-label={t("settings.layout.paragraphSpacing")}>
            {(["none", "compact", "comfortable", "loose"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={paragraphSpacing === value} onClick={() => {
                setParagraphSpacing(value); save("paragraph_spacing", value); showSavedToast();
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
            setFirstLineIndent(value); save("first_line_indent", String(value)); showSavedToast();
          }} />
        </div>
      </div>
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.margins")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.marginsHint")}</p>
        </div>
        <NumberInput value={margins} onChange={setMargins} onBlur={() => save("margins", String(margins))} suffix="%" min={0} max={30} />
      </div>
      {/* Default Page Flow */}
      <div className="flex items-center justify-between h-[73px]">
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
            save("reading_mode", next);
            showSavedToast();
          }}
          options={[
            { value: "scrolling", label: t("readerSettings.scrolling") },
            { value: "paginated", label: t("readerSettings.pageTurning") },
          ]}
        />
      </div>
      {/* Default Page Layout */}
      <div className="flex items-center justify-between h-[73px]">
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
            save("page_columns", next);
            showSavedToast();
          }}
          options={[
            { value: "1", label: t("readerSettings.singlePage") },
            { value: "2", label: t("readerSettings.twoPages") },
          ]}
        />
      </div>
      {/* Page-turn Animation */}
      <div className="flex items-center justify-between h-[73px]">
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
            save("page_turn_animation", next);
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
                save("show_chapter_progress", String(v));
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
                save("show_book_progress", String(v));
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
                save("show_page_numbers", String(v));
                showSavedToast();
              }}
            />
          </div>
        </div>
      </div>
      {/* Previous-page Control */}
      <div className="flex items-center justify-between h-[73px]">
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
            void saveBulk(
              swapsNext
                ? { previous_page_binding: value, next_page_binding: previous }
                : { previous_page_binding: value },
            ).then(() => showSavedToast());
          }}
        />
      </div>
      {/* Next-page Control */}
      <div className="flex items-center justify-between h-[73px]">
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
            void saveBulk(
              swapsPrevious
                ? { next_page_binding: value, previous_page_binding: previous }
                : { next_page_binding: value },
            ).then(() => showSavedToast());
          }}
        />
      </div>
    </div>
  );
}
