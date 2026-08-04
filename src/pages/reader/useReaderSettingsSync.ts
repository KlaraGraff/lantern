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
// Explicit extensions and type-only imports: the unit tests load this module
// through Node's ESM loader, which neither resolves extensionless relative
// paths nor drops an import whose only bindings are types.
import type {
  PageColumns,
  PageTurnAnimation,
  ReaderSettingsState,
  ReadingMode,
} from "../../components/ReaderSettings";
import {
  getDefaultReaderTheme,
  isReaderFontAvailable,
  parseReaderCustomTheme,
} from "../../components/reader-settings.ts";
import {
  DEFAULT_NEXT_PAGE_BINDING,
  DEFAULT_PREVIOUS_PAGE_BINDING,
} from "../../components/page-turn-bindings.ts";
import {
  listenForSettingsChanged,
  notifySettingsChanged,
} from "../../components/settings-events.ts";
import {
  encodeReaderSetting,
  perBookOverrideKeys,
  perBookSettingKeys,
  type PerBookReaderSettings,
} from "./reader-settings-scope.ts";

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
  textJustification: "text_justification",
  paragraphSpacing: "paragraph_spacing",
  firstLineIndent: "first_line_indent",
} as const;

// Every setting the reader panel can hold per book, as `book_settings` rows: one
// row per key, and *the row existing is the override*.
//
// Most are also owned globally by the Settings page. Writing them
// unconditionally froze every book that had ever been opened at the values of its
// first open — `blob.fontSize ?? global.font_size` never fell through again — so a
// row is written only when the user changes the value in the reader panel, and a
// book with no row follows the Settings page.
//
// The four marker toggles have no global counterpart: the reader panel is their only
// control, so a row is the only place the choice can live. They used to sit in the
// `reader-settings-<bookId>` localStorage blob, which is why that blob existed;
// with them here it is gone entirely.
//
// `customTheme` remains global-only. P2.4 deliberately adds reading mode, page
// columns and margins to the override set; animation, progress and bindings stay
// global muscle-memory behavior.
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

function numberSetting(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function paragraphSpacingSetting(
  value: string | undefined,
  fallback: ReaderSettingsState["paragraphSpacing"],
): ReaderSettingsState["paragraphSpacing"] {
  return value === "original" || value === "none" || value === "compact"
    || value === "comfortable" || value === "loose" ? value : fallback;
}

function marginSetting(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(30, Math.max(0, parsed)) : fallback;
}

const DEFAULT_MARKER_VISIBILITY = {
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
  showMasteredMarkers: false,
} as const;

function createDefaultReaderSettings(): ReaderSettingsState {
  return {
    theme: getDefaultReaderTheme(),
    customTheme: parseReaderCustomTheme(null),
    font: "palatino",
    fontSize: 26,
    narrowFontShrink: true,
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
    textJustification: false,
    paragraphSpacing: "original",
    firstLineIndent: false,
    margins: 0,
    ...DEFAULT_MARKER_VISIBILITY,
  };
}

export function resolveReaderSettings(
  previous: ReaderSettingsState,
  globalSettings: Record<string, string>,
  perBookSettings: PerBookReaderSettings = {},
): ReaderSettingsState {
  // Two sources only: `book_settings` rows for the per-book overrides and the
  // global `settings` table for everything else. The per-book localStorage blob is
  // retired — it could not distinguish "not overridden" from "overridden to the
  // global value", and its full-snapshot writes froze every key it carried.
  const requestedFont = (perBookSettings[perBookSettingKeys.font] as ReaderSettingsState["font"])
    || (globalSettings.font_family as ReaderSettingsState["font"])
    || previous.font;
  return {
    ...previous,
    theme: (perBookSettings[perBookSettingKeys.theme] as ReaderSettingsState["theme"])
      || (globalSettings.reader_theme as ReaderSettingsState["theme"])
      || previous.theme,
    // Global-only: the reader panel edits it straight into the global setting.
    customTheme: parseReaderCustomTheme(globalSettings.reader_custom_theme),
    pageColumns: pageColumnsSetting(
      perBookSettings[perBookSettingKeys.pageColumns],
      pageColumnsSetting(globalSettings.page_columns, previous.pageColumns),
    ),
    font: isReaderFontAvailable(requestedFont) ? requestedFont : "system",
    fontSize: numberSetting(perBookSettings[perBookSettingKeys.fontSize])
      ?? (globalSettings.font_size ? parseInt(globalSettings.font_size) : previous.fontSize),
    // Global-only: the reader panel has no per-book control for it.
    narrowFontShrink: booleanSetting(globalSettings.narrow_font_shrink, previous.narrowFontShrink),
    // Reading mode is book-shaped; animation and the following controls remain
    // global behavior that must not vary between books.
    readingMode: readingModeSetting(
      perBookSettings[perBookSettingKeys.readingMode],
      readingModeSetting(globalSettings.reading_mode, previous.readingMode),
    ),
    pageTurnAnimation: pageTurnAnimationSetting(globalSettings.page_turn_animation, previous.pageTurnAnimation),
    showChapterProgress: booleanSetting(globalSettings.show_chapter_progress, previous.showChapterProgress),
    showBookProgress: booleanSetting(globalSettings.show_book_progress, previous.showBookProgress),
    showPageNumbers: booleanSetting(globalSettings.show_page_numbers, previous.showPageNumbers),
    previousPageBinding: globalSettings.previous_page_binding || previous.previousPageBinding,
    nextPageBinding: globalSettings.next_page_binding || previous.nextPageBinding,
    lineSpacing: numberSetting(perBookSettings[perBookSettingKeys.lineSpacing])
      ?? (globalSettings.line_spacing ? parseFloat(globalSettings.line_spacing) : previous.lineSpacing),
    wordSpacing: numberSetting(perBookSettings[perBookSettingKeys.wordSpacing])
      ?? (globalSettings.word_spacing ? parseInt(globalSettings.word_spacing) : previous.wordSpacing),
    textJustification: booleanSetting(
      perBookSettings[perBookSettingKeys.textJustification],
      booleanSetting(globalSettings.text_justification, previous.textJustification),
    ),
    paragraphSpacing: paragraphSpacingSetting(
      perBookSettings[perBookSettingKeys.paragraphSpacing],
      paragraphSpacingSetting(globalSettings.paragraph_spacing, previous.paragraphSpacing),
    ),
    firstLineIndent: booleanSetting(
      perBookSettings[perBookSettingKeys.firstLineIndent],
      booleanSetting(globalSettings.first_line_indent, previous.firstLineIndent),
    ),
    margins: marginSetting(
      perBookSettings[perBookSettingKeys.margins],
      marginSetting(globalSettings.margins, previous.margins),
    ),
    charSpacing: numberSetting(perBookSettings[perBookSettingKeys.charSpacing])
      ?? (globalSettings.char_spacing ? parseInt(globalSettings.char_spacing) : previous.charSpacing),
    showLookupMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showLookupMarkers],
      DEFAULT_MARKER_VISIBILITY.showLookupMarkers,
    ),
    showNewVocabMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showNewVocabMarkers],
      DEFAULT_MARKER_VISIBILITY.showNewVocabMarkers,
    ),
    showLearningMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showLearningMarkers],
      DEFAULT_MARKER_VISIBILITY.showLearningMarkers,
    ),
    showMasteredMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showMasteredMarkers],
      DEFAULT_MARKER_VISIBILITY.showMasteredMarkers,
    ),
  };
}

interface ReaderSettingsController {
  readerSettings: ReaderSettingsState;
  globalReaderSettings: ReaderSettingsState;
  setReaderSettings: Dispatch<SetStateAction<ReaderSettingsState>>;
  readerSettingsRef: MutableRefObject<ReaderSettingsState>;
  settingsLoadedBookRef: MutableRefObject<string | null>;
  bookOverrides: PerBookReaderSettings;
  loadReaderSettingsSources(
    globalSettings: Record<string, string>,
    perBookSettings: PerBookReaderSettings,
  ): void;
  handleReaderSettingsChange(next: ReaderSettingsState): void;
  restoreBookOverrides(keys: string[]): Promise<Record<string, string>>;
  undoRestoreBookOverrides(values: Record<string, string>): Promise<void>;
  promoteBookOverrides(selectedBookIds: string[]): Promise<Record<string, string>>;
}

export function useReaderSettingsSync(bookId: string | undefined): ReaderSettingsController {
  const [readerSettings, setReaderSettings] = useState<ReaderSettingsState>(createDefaultReaderSettings);
  const [globalReaderSettings, setGlobalReaderSettings] = useState<ReaderSettingsState>(createDefaultReaderSettings);
  const [bookOverrides, setBookOverrides] = useState<PerBookReaderSettings>({});
  const bookOverridesRef = useRef<PerBookReaderSettings>({});
  const globalSettingsRef = useRef<Record<string, string>>({});
  const readerSettingsRef = useRef(readerSettings);
  const settingsLoadedBookRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingPreferencesRef = useRef<Record<string, string>>({});
  const bookSaveTimerRef = useRef<number | null>(null);
  // Keyed by book id: a batch outlives the book it belongs to only until the
  // flush below, and must never be written against whatever book is open then.
  const pendingBookSettingsRef = useRef<Record<string, Record<string, string>>>({});

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  useEffect(() => {
    bookOverridesRef.current = bookOverrides;
  }, [bookOverrides]);

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

  // One `set_book_settings_bulk` per settle: an override write is a database
  // write *and*, for `font`, a sync event, so a dragged slider must not emit one
  // per frame. Closing the book mid-debounce still lands the edit — the effect
  // below flushes on every `bookId` change and on unmount, and each batch is
  // written against the book it was queued under, not the one now open.
  const flushBookSettings = useCallback(async (throwOnError = false) => {
    bookSaveTimerRef.current = null;
    const pending = pendingBookSettingsRef.current;
    pendingBookSettingsRef.current = {};
    let failed = false;
    for (const [book, values] of Object.entries(pending)) {
      try {
        await invoke("set_book_settings_bulk", { bookId: book, settings: values });
      } catch {
        failed = true;
        // Keep the edit queued for the next settle, letting newer values win.
        pendingBookSettingsRef.current[book] = {
          ...values,
          ...pendingBookSettingsRef.current[book],
        };
      }
    }
    if (failed && throwOnError) throw new Error("BOOK_SETTINGS_SAVE_FAILED");
  }, []);

  const scheduleBookSettingsSave = useCallback((book: string, values: Record<string, string>) => {
    if (Object.keys(values).length === 0) return;
    pendingBookSettingsRef.current[book] = {
      ...pendingBookSettingsRef.current[book],
      ...values,
    };
    if (bookSaveTimerRef.current !== null) window.clearTimeout(bookSaveTimerRef.current);
    bookSaveTimerRef.current = window.setTimeout(() => {
      void flushBookSettings();
    }, 400);
  }, [flushBookSettings]);

  const loadReaderSettingsSources = useCallback((
    globalSettings: Record<string, string>,
    perBookSettings: PerBookReaderSettings,
  ) => {
    globalSettingsRef.current = globalSettings;
    setGlobalReaderSettings(resolveReaderSettings(createDefaultReaderSettings(), globalSettings));
    bookOverridesRef.current = perBookSettings;
    setBookOverrides(perBookSettings);
    setReaderSettings((previous) => {
      const next = resolveReaderSettings(previous, globalSettings, perBookSettings);
      readerSettingsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => () => {
    if (bookSaveTimerRef.current !== null) window.clearTimeout(bookSaveTimerRef.current);
    void flushBookSettings();
  }, [bookId, flushBookSettings]);

  const handleReaderSettingsChange = useCallback((next: ReaderSettingsState) => {
    const previous = readerSettingsRef.current;
    readerSettingsRef.current = next;
    setReaderSettings(next);
    // This callback only runs for edits made in the reader's own settings panel,
    // so a differing value here is exactly the per-book override signal. Gated on
    // the async load: before it finishes the merge has not run yet, so `previous`
    // is still the defaults and every key would look changed.
    if (bookId && settingsLoadedBookRef.current === bookId) {
      const changedOverrides: Record<string, string> = {};
      for (const key of perBookOverrideKeys) {
        if (previous[key] !== next[key]) {
          changedOverrides[perBookSettingKeys[key]] = encodeReaderSetting(key, next);
        }
      }
      if (Object.keys(changedOverrides).length > 0) {
        setBookOverrides((current) => {
          const updated = { ...current, ...changedOverrides };
          bookOverridesRef.current = updated;
          return updated;
        });
      }
      scheduleBookSettingsSave(bookId, changedOverrides);
    }
    const changed: Record<string, string> = {};
    if (previous.customTheme.color !== next.customTheme.color
      || previous.customTheme.opacity !== next.customTheme.opacity) {
      changed[readerPreferenceSettingKeys.customTheme] = JSON.stringify(next.customTheme);
    }
    if (previous.pageTurnAnimation !== next.pageTurnAnimation) changed[readerPreferenceSettingKeys.pageTurnAnimation] = next.pageTurnAnimation;
    if (previous.showChapterProgress !== next.showChapterProgress) changed[readerPreferenceSettingKeys.showChapterProgress] = String(next.showChapterProgress);
    if (previous.showBookProgress !== next.showBookProgress) changed[readerPreferenceSettingKeys.showBookProgress] = String(next.showBookProgress);
    if (previous.showPageNumbers !== next.showPageNumbers) changed[readerPreferenceSettingKeys.showPageNumbers] = String(next.showPageNumbers);
    if (previous.previousPageBinding !== next.previousPageBinding) changed[readerPreferenceSettingKeys.previousPageBinding] = next.previousPageBinding;
    if (previous.nextPageBinding !== next.nextPageBinding) changed[readerPreferenceSettingKeys.nextPageBinding] = next.nextPageBinding;
    scheduleReaderPreferenceSave(changed);
  }, [bookId, scheduleBookSettingsSave, scheduleReaderPreferenceSave, settingsLoadedBookRef]);

  const applySources = useCallback((
    globals: Record<string, string>,
    overrides: PerBookReaderSettings,
  ) => {
    globalSettingsRef.current = globals;
    setGlobalReaderSettings(resolveReaderSettings(createDefaultReaderSettings(), globals));
    bookOverridesRef.current = overrides;
    setBookOverrides(overrides);
    setReaderSettings((previous) => {
      const next = resolveReaderSettings(previous, globals, overrides);
      readerSettingsRef.current = next;
      return next;
    });
  }, []);

  const restoreBookOverrides = useCallback(async (keys: string[]) => {
    if (!bookId || keys.length === 0) return {};
    const pending = pendingBookSettingsRef.current[bookId];
    const pendingDeleted: Record<string, string> = {};
    if (pending) {
      for (const key of keys) {
        if (pending[key] !== undefined) pendingDeleted[key] = pending[key];
        delete pending[key];
      }
      if (Object.keys(pending).length === 0) delete pendingBookSettingsRef.current[bookId];
    }
    let deleted: Record<string, string>;
    try {
      deleted = await invoke<Record<string, string>>("delete_book_settings", { bookId, keys });
    } catch (error) {
      scheduleBookSettingsSave(bookId, pendingDeleted);
      throw error;
    }
    const remaining = { ...bookOverrides };
    for (const key of keys) delete remaining[key];
    applySources(globalSettingsRef.current, remaining);
    return { ...deleted, ...pendingDeleted };
  }, [applySources, bookId, bookOverrides, scheduleBookSettingsSave]);

  const undoRestoreBookOverrides = useCallback(async (values: Record<string, string>) => {
    if (!bookId || Object.keys(values).length === 0) return;
    await invoke("set_book_settings_bulk", { bookId, settings: values });
    applySources(globalSettingsRef.current, { ...bookOverrides, ...values });
  }, [applySources, bookId, bookOverrides]);

  const promoteBookOverrides = useCallback(async (selectedBookIds: string[]) => {
    if (!bookId) return {};
    await flushBookSettings(true);
    const result = await invoke<{ settings: Record<string, string>; promoted_keys: string[] }>(
      "promote_book_settings_to_global",
      { sourceBookId: bookId, selectedBookIds },
    );
    const remaining = { ...bookOverrides };
    for (const key of result.promoted_keys) delete remaining[key];
    const globals = { ...globalSettingsRef.current, ...result.settings };
    applySources(globals, remaining);
    await notifySettingsChanged(result.settings).catch(() => {});
    return result.settings;
  }, [applySources, bookId, bookOverrides, flushBookSettings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (disposed) return;
      globalSettingsRef.current = { ...globalSettingsRef.current, ...values };
      setGlobalReaderSettings(resolveReaderSettings(
        createDefaultReaderSettings(),
        globalSettingsRef.current,
      ));
      setReaderSettings((current) => {
        const next = resolveReaderSettings(
          current,
          globalSettingsRef.current,
          bookOverridesRef.current,
        );
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

  return {
    readerSettings,
    globalReaderSettings,
    setReaderSettings,
    readerSettingsRef,
    settingsLoadedBookRef,
    bookOverrides,
    loadReaderSettingsSources,
    handleReaderSettingsChange,
    restoreBookOverrides,
    undoRestoreBookOverrides,
    promoteBookOverrides,
  };
}
