import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type PageColumns,
  type PageTurnAnimation,
  type ReaderSettingsState,
  type ReadingMode,
} from "../../components/ReaderSettings";
import {
  getDefaultReaderTheme,
  isReaderFontAvailable,
  parseReaderCustomTheme,
} from "../../components/reader-settings";
import {
  DEFAULT_NEXT_PAGE_BINDING,
  DEFAULT_PREVIOUS_PAGE_BINDING,
} from "../../components/page-turn-bindings";
import {
  listenForSettingsChanged,
  notifySettingsChanged,
} from "../../components/settings-events";

const readerPreferenceSettingKeys = {
  theme: "reader_theme",
  customTheme: "reader_custom_theme",
  margins: "margins",
  readingMode: "reading_mode",
  pageColumns: "page_columns",
  pageTurnAnimation: "page_turn_animation",
  showChapterProgress: "show_chapter_progress",
  showBookProgress: "show_book_progress",
  showPageNumbers: "show_page_numbers",
  previousPageBinding: "previous_page_binding",
  nextPageBinding: "next_page_binding",
  narrowFontShrink: "narrow_font_shrink",
} as const;

// Typography that the Settings page owns globally *and* the reader panel can
// override for one book. Writing these unconditionally froze every book that had
// ever been opened at the values of its first open: `bookSettings.fontSize ??
// global.font_size` then never fell through again. They are now stored only once
// the user changes them in the reader, and `typographyOverrides` records that
// intent explicitly — a blob without it is a snapshot from the old behaviour and
// carries no overrides, so those books follow the Settings page again.
// `theme` is deliberately not in this list. It has the same problem, but which
// way it should resolve is a separate open decision.
const perBookTypographyKeys = ["font", "fontSize", "lineSpacing", "wordSpacing"] as const;
type PerBookTypographyKey = (typeof perBookTypographyKeys)[number];

export interface StoredReaderSettings extends Partial<ReaderSettingsState> {
  typographyOverrides?: PerBookTypographyKey[];
}

function readStoredOverrides(bookId: string | undefined): Set<PerBookTypographyKey> {
  if (!bookId) return new Set();
  const saved = localStorage.getItem(`reader-settings-${bookId}`);
  if (!saved) return new Set();
  try {
    const parsed = JSON.parse(saved) as StoredReaderSettings;
    return new Set((parsed.typographyOverrides ?? []).filter(
      (key): key is PerBookTypographyKey => perBookTypographyKeys.includes(key),
    ));
  } catch {
    // A corrupt blob simply means no overrides; Reader.tsx clears the key.
    return new Set();
  }
}

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function readingModeSetting(value: string | undefined, fallback: ReadingMode): ReadingMode {
  return value === "paginated" || value === "scrolling" ? value : fallback;
}

function pageColumnsSetting(value: string | undefined, fallback: PageColumns): PageColumns {
  return value === "1" ? 1 : value === "2" ? 2 : fallback;
}

function pageTurnAnimationSetting(
  value: string | undefined,
  fallback: PageTurnAnimation,
): PageTurnAnimation {
  return value === "none" || value === "slide" || value === "fade" || value === "cover"
    ? value
    : fallback;
}

function marginSetting(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(30, Math.max(0, parsed)) : fallback;
}

function createDefaultReaderSettings(): ReaderSettingsState {
  return {
    theme: getDefaultReaderTheme(),
    customTheme: parseReaderCustomTheme(null),
    font: "palatino",
    fontSize: 26,
    narrowFontShrink: true,
    brightness: 100,
    readingMode: "scrolling",
    pageColumns: 2,
    pageTurnAnimation: "slide",
    showChapterProgress: true,
    showBookProgress: false,
    showPageNumbers: false,
    previousPageBinding: DEFAULT_PREVIOUS_PAGE_BINDING,
    nextPageBinding: DEFAULT_NEXT_PAGE_BINDING,
    lineSpacing: 1.8,
    charSpacing: 0,
    wordSpacing: 0,
    margins: 0,
    showLookupMarkers: true,
    showNewVocabMarkers: true,
    showLearningMarkers: true,
    showMasteredMarkers: false,
  };
}

export function mergeStoredReaderSettings(
  previous: ReaderSettingsState,
  storedSettings: StoredReaderSettings,
  globalSettings: Record<string, string>,
): ReaderSettingsState {
  const overrides = new Set(storedSettings.typographyOverrides ?? []);
  const bookSettings: Partial<ReaderSettingsState> = { ...storedSettings };
  for (const key of perBookTypographyKeys) {
    if (!overrides.has(key)) delete bookSettings[key];
  }
  const requestedFont = bookSettings.font
    || (globalSettings.font_family as ReaderSettingsState["font"])
    || previous.font;
  return {
    ...previous,
    theme: bookSettings.theme
      || (globalSettings.reader_theme as ReaderSettingsState["theme"])
      || previous.theme,
    customTheme: parseReaderCustomTheme(globalSettings.reader_custom_theme ?? bookSettings.customTheme),
    brightness: bookSettings.brightness
      ?? (globalSettings.brightness ? parseInt(globalSettings.brightness) : previous.brightness),
    pageColumns: bookSettings.pageColumns
      ?? pageColumnsSetting(globalSettings.page_columns, previous.pageColumns),
    font: isReaderFontAvailable(requestedFont) ? requestedFont : "system",
    fontSize: bookSettings.fontSize
      ?? (globalSettings.font_size ? parseInt(globalSettings.font_size) : previous.fontSize),
    // Global-only: the reader panel has no per-book control for it.
    narrowFontShrink: booleanSetting(globalSettings.narrow_font_shrink, previous.narrowFontShrink),
    readingMode: bookSettings.readingMode
      || readingModeSetting(globalSettings.reading_mode, previous.readingMode),
    pageTurnAnimation: bookSettings.pageTurnAnimation
      ?? pageTurnAnimationSetting(globalSettings.page_turn_animation, previous.pageTurnAnimation),
    showChapterProgress: bookSettings.showChapterProgress
      ?? booleanSetting(globalSettings.show_chapter_progress, previous.showChapterProgress),
    showBookProgress: bookSettings.showBookProgress
      ?? booleanSetting(globalSettings.show_book_progress, previous.showBookProgress),
    showPageNumbers: bookSettings.showPageNumbers
      ?? booleanSetting(globalSettings.show_page_numbers, previous.showPageNumbers),
    previousPageBinding: bookSettings.previousPageBinding
      || globalSettings.previous_page_binding
      || previous.previousPageBinding,
    nextPageBinding: bookSettings.nextPageBinding
      || globalSettings.next_page_binding
      || previous.nextPageBinding,
    lineSpacing: bookSettings.lineSpacing
      ?? (globalSettings.line_spacing ? parseFloat(globalSettings.line_spacing) : previous.lineSpacing),
    charSpacing: bookSettings.charSpacing
      ?? (globalSettings.char_spacing ? parseInt(globalSettings.char_spacing) : previous.charSpacing),
    wordSpacing: bookSettings.wordSpacing
      ?? (globalSettings.word_spacing ? parseInt(globalSettings.word_spacing) : previous.wordSpacing),
    // Global-first keeps the Settings page and reader toolbar synchronized.
    margins: marginSetting(globalSettings.margins ?? bookSettings.margins, previous.margins),
    showLookupMarkers: bookSettings.showLookupMarkers ?? previous.showLookupMarkers,
    showNewVocabMarkers: bookSettings.showNewVocabMarkers ?? previous.showNewVocabMarkers,
    showLearningMarkers: bookSettings.showLearningMarkers ?? previous.showLearningMarkers,
    showMasteredMarkers: bookSettings.showMasteredMarkers ?? previous.showMasteredMarkers,
  };
}

interface ReaderSettingsController {
  readerSettings: ReaderSettingsState;
  setReaderSettings: Dispatch<SetStateAction<ReaderSettingsState>>;
  readerSettingsRef: MutableRefObject<ReaderSettingsState>;
  settingsLoadedBookRef: MutableRefObject<string | null>;
  handleReaderSettingsChange(next: ReaderSettingsState): void;
}

export function useReaderSettingsSync(bookId: string | undefined): ReaderSettingsController {
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>(createDefaultReaderSettings);
  const readerSettingsRef = useRef(readerSettings);
  const settingsLoadedBookRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingPreferencesRef = useRef<Record<string, string>>({});
  const typographyOverridesRef = useRef<Set<PerBookTypographyKey>>(new Set());

  // Seed from whatever the book already has. Runs before the first write, which
  // is gated on the async settings load finishing, so nothing is lost.
  useEffect(() => {
    typographyOverridesRef.current = readStoredOverrides(bookId);
  }, [bookId]);

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  const flushReaderPreferences = useCallback(async () => {
    saveTimerRef.current = null;
    const values = pendingPreferencesRef.current;
    pendingPreferencesRef.current = {};
    if (Object.keys(values).length === 0) return;
    try {
      await invoke("set_settings_bulk", { settings: values });
      await notifySettingsChanged(values).catch(() => {});
    } catch {
      pendingPreferencesRef.current = {
        ...values,
        ...pendingPreferencesRef.current,
      };
    }
  }, []);

  const scheduleReaderPreferenceSave = useCallback((values: Record<string, string>) => {
    if (Object.keys(values).length === 0) return;
    pendingPreferencesRef.current = {
      ...pendingPreferencesRef.current,
      ...values,
    };
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushReaderPreferences();
    }, 400);
  }, [flushReaderPreferences]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    void flushReaderPreferences();
  }, [flushReaderPreferences]);

  const handleReaderSettingsChange = useCallback((next: ReaderSettingsState) => {
    const previous = readerSettingsRef.current;
    readerSettingsRef.current = next;
    setReaderSettings(next);
    // This callback only runs for edits made in the reader's own settings panel,
    // so a differing value here is exactly the per-book override signal.
    for (const key of perBookTypographyKeys) {
      if (previous[key] !== next[key]) typographyOverridesRef.current.add(key);
    }
    const changed: Record<string, string> = {};
    if (previous.theme !== next.theme) changed[readerPreferenceSettingKeys.theme] = next.theme;
    if (previous.customTheme.color !== next.customTheme.color
      || previous.customTheme.opacity !== next.customTheme.opacity) {
      changed[readerPreferenceSettingKeys.customTheme] = JSON.stringify(next.customTheme);
    }
    if (previous.margins !== next.margins) changed[readerPreferenceSettingKeys.margins] = String(next.margins);
    if (previous.readingMode !== next.readingMode) changed[readerPreferenceSettingKeys.readingMode] = next.readingMode;
    if (previous.pageColumns !== next.pageColumns) changed[readerPreferenceSettingKeys.pageColumns] = String(next.pageColumns);
    if (previous.pageTurnAnimation !== next.pageTurnAnimation) changed[readerPreferenceSettingKeys.pageTurnAnimation] = next.pageTurnAnimation;
    if (previous.showChapterProgress !== next.showChapterProgress) changed[readerPreferenceSettingKeys.showChapterProgress] = String(next.showChapterProgress);
    if (previous.showBookProgress !== next.showBookProgress) changed[readerPreferenceSettingKeys.showBookProgress] = String(next.showBookProgress);
    if (previous.showPageNumbers !== next.showPageNumbers) changed[readerPreferenceSettingKeys.showPageNumbers] = String(next.showPageNumbers);
    if (previous.previousPageBinding !== next.previousPageBinding) changed[readerPreferenceSettingKeys.previousPageBinding] = next.previousPageBinding;
    if (previous.nextPageBinding !== next.nextPageBinding) changed[readerPreferenceSettingKeys.nextPageBinding] = next.nextPageBinding;
    scheduleReaderPreferenceSave(changed);
  }, [scheduleReaderPreferenceSave]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (disposed) return;
      setReaderSettings((current) => {
        const next = {
          ...current,
          theme: (values[readerPreferenceSettingKeys.theme] as ReaderSettingsState["theme"]) || current.theme,
          customTheme: values[readerPreferenceSettingKeys.customTheme]
            ? parseReaderCustomTheme(values[readerPreferenceSettingKeys.customTheme])
            : current.customTheme,
          margins: marginSetting(values[readerPreferenceSettingKeys.margins], current.margins),
          readingMode: readingModeSetting(
            values[readerPreferenceSettingKeys.readingMode],
            current.readingMode,
          ),
          pageColumns: pageColumnsSetting(
            values[readerPreferenceSettingKeys.pageColumns],
            current.pageColumns,
          ),
          pageTurnAnimation: pageTurnAnimationSetting(
            values[readerPreferenceSettingKeys.pageTurnAnimation],
            current.pageTurnAnimation,
          ),
          showChapterProgress: booleanSetting(
            values[readerPreferenceSettingKeys.showChapterProgress],
            current.showChapterProgress,
          ),
          showBookProgress: booleanSetting(
            values[readerPreferenceSettingKeys.showBookProgress],
            current.showBookProgress,
          ),
          showPageNumbers: booleanSetting(
            values[readerPreferenceSettingKeys.showPageNumbers],
            current.showPageNumbers,
          ),
          previousPageBinding: values[readerPreferenceSettingKeys.previousPageBinding]
            || current.previousPageBinding,
          nextPageBinding: values[readerPreferenceSettingKeys.nextPageBinding]
            || current.nextPageBinding,
          narrowFontShrink: booleanSetting(
            values[readerPreferenceSettingKeys.narrowFontShrink],
            current.narrowFontShrink,
          ),
        };
        readerSettingsRef.current = next;
        return next;
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (settingsLoadedBookRef.current !== bookId) return;
    const overrides = typographyOverridesRef.current;
    const stored: StoredReaderSettings = { ...readerSettings };
    for (const key of perBookTypographyKeys) {
      if (!overrides.has(key)) delete stored[key];
    }
    // Never a per-book value: it is a global preference with no reader control.
    delete stored.narrowFontShrink;
    if (overrides.size > 0) stored.typographyOverrides = [...overrides];
    localStorage.setItem(`reader-settings-${bookId}`, JSON.stringify(stored));
  }, [bookId, readerSettings]);

  return {
    readerSettings,
    setReaderSettings,
    readerSettingsRef,
    settingsLoadedBookRef,
    handleReaderSettingsChange,
  };
}
