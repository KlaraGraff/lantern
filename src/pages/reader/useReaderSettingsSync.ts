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

// Settings the Settings page owns globally *and* the reader panel can override
// for one book. Writing these unconditionally froze every book that had ever
// been opened at the values of its first open: `storedSettings.fontSize ??
// global.font_size` then never fell through again — and `theme` froze the same
// way. They now live in `book_settings`, one row per key, written only when the
// user changes them in the reader panel, so *the row existing is the override*
// and a book with no row follows the Settings page. `customTheme` does not
// belong here — it is global-only (see the merge below), so there is nothing
// per-book to record.
const perBookSettingKeys = {
  theme: "theme",
  font: "font",
  fontSize: "font_size",
  lineSpacing: "line_spacing",
  wordSpacing: "word_spacing",
} as const;
type PerBookOverrideKey = keyof typeof perBookSettingKeys;

const perBookOverrideKeys = Object.keys(perBookSettingKeys) as PerBookOverrideKey[];

// Settings the reader panel edits straight into the *global* setting: every key
// here is a `readerPreferenceSettingKeys` member that `handleReaderSettingsChange`
// writes globally, so there is no per-book intent to record. Keeping a copy in the
// blob made it a stale duplicate that then won the merge (`blob ?? global`) and
// froze every already-opened book at its last-seen value — the same freeze the
// typography keys were rescued from. The blob never carries them again.
const globalOnlySettingKeys = [
  "readingMode",
  "pageColumns",
  "pageTurnAnimation",
  "showChapterProgress",
  "showBookProgress",
  "showPageNumbers",
  "previousPageBinding",
  "nextPageBinding",
  "narrowFontShrink",
] as const;

/** Per-book rows as `get_book_settings` returns them: raw key/value strings. */
export type PerBookReaderSettings = Record<string, string>;

export type StoredReaderSettings = Partial<ReaderSettingsState>;

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
  perBookSettings: PerBookReaderSettings = {},
): ReaderSettingsState {
  // `storedSettings` is the legacy per-book blob. It no longer contributes any of
  // `perBookSettingKeys` (those come from `book_settings` rows) nor any of
  // `globalOnlySettingKeys` (those come from the global settings), so a blob
  // written by an older build cannot resurrect either freeze. All it still
  // supplies is state with no other home: `charSpacing` and the marker toggles.
  const requestedFont = (perBookSettings[perBookSettingKeys.font] as ReaderSettingsState["font"])
    || (globalSettings.font_family as ReaderSettingsState["font"])
    || previous.font;
  return {
    ...previous,
    theme: (perBookSettings[perBookSettingKeys.theme] as ReaderSettingsState["theme"])
      || (globalSettings.reader_theme as ReaderSettingsState["theme"])
      || previous.theme,
    // Global-only: the reader panel edits it straight into the global setting.
    customTheme: parseReaderCustomTheme(globalSettings.reader_custom_theme ?? storedSettings.customTheme),
    pageColumns: pageColumnsSetting(globalSettings.page_columns, previous.pageColumns),
    font: isReaderFontAvailable(requestedFont) ? requestedFont : "system",
    fontSize: numberSetting(perBookSettings[perBookSettingKeys.fontSize])
      ?? (globalSettings.font_size ? parseInt(globalSettings.font_size) : previous.fontSize),
    // Global-only: the reader panel has no per-book control for it.
    narrowFontShrink: booleanSetting(globalSettings.narrow_font_shrink, previous.narrowFontShrink),
    // Global-only, all of them: see `globalOnlySettingKeys`. Reading the blob here
    // is what froze a reopened book at its last-seen layout.
    readingMode: readingModeSetting(globalSettings.reading_mode, previous.readingMode),
    pageTurnAnimation: pageTurnAnimationSetting(globalSettings.page_turn_animation, previous.pageTurnAnimation),
    showChapterProgress: booleanSetting(globalSettings.show_chapter_progress, previous.showChapterProgress),
    showBookProgress: booleanSetting(globalSettings.show_book_progress, previous.showBookProgress),
    showPageNumbers: booleanSetting(globalSettings.show_page_numbers, previous.showPageNumbers),
    previousPageBinding: globalSettings.previous_page_binding || previous.previousPageBinding,
    nextPageBinding: globalSettings.next_page_binding || previous.nextPageBinding,
    lineSpacing: numberSetting(perBookSettings[perBookSettingKeys.lineSpacing])
      ?? (globalSettings.line_spacing ? parseFloat(globalSettings.line_spacing) : previous.lineSpacing),
    // Genuinely per-book: the reader panel is its only control and there is no
    // global counterpart, so the blob is its only storage. (There was a
    // `globalSettings.char_spacing` fallback here; nothing in the repo ever wrote
    // that key, so it could only ever be `undefined`.)
    charSpacing: storedSettings.charSpacing ?? previous.charSpacing,
    wordSpacing: numberSetting(perBookSettings[perBookSettingKeys.wordSpacing])
      ?? (globalSettings.word_spacing ? parseInt(globalSettings.word_spacing) : previous.wordSpacing),
    // Global-first keeps the Settings page and reader toolbar synchronized.
    margins: marginSetting(globalSettings.margins ?? storedSettings.margins, previous.margins),
    showLookupMarkers: storedSettings.showLookupMarkers ?? previous.showLookupMarkers,
    showNewVocabMarkers: storedSettings.showNewVocabMarkers ?? previous.showNewVocabMarkers,
    showLearningMarkers: storedSettings.showLearningMarkers ?? previous.showLearningMarkers,
    showMasteredMarkers: storedSettings.showMasteredMarkers ?? previous.showMasteredMarkers,
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
  const bookSaveTimerRef = useRef<number | null>(null);
  // Keyed by book id: a batch outlives the book it belongs to only until the
  // flush below, and must never be written against whatever book is open then.
  const pendingBookSettingsRef = useRef<Record<string, Record<string, string>>>({});

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

  // One `set_book_settings_bulk` per settle: an override write is a database
  // write *and*, for `font`, a sync event, so a dragged slider must not emit one
  // per frame. Closing the book mid-debounce still lands the edit — the effect
  // below flushes on every `bookId` change and on unmount, and each batch is
  // written against the book it was queued under, not the one now open.
  const flushBookSettings = useCallback(async () => {
    bookSaveTimerRef.current = null;
    const pending = pendingBookSettingsRef.current;
    pendingBookSettingsRef.current = {};
    for (const [book, values] of Object.entries(pending)) {
      try {
        await invoke("set_book_settings_bulk", { bookId: book, settings: values });
      } catch {
        // Keep the edit queued for the next settle, letting newer values win.
        pendingBookSettingsRef.current[book] = {
          ...values,
          ...pendingBookSettingsRef.current[book],
        };
      }
    }
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
    // the async load the same way the blob write is: before it finishes the merge
    // has not run yet, and a row written now would be overwritten by it anyway.
    if (bookId && settingsLoadedBookRef.current === bookId) {
      const changedOverrides: Record<string, string> = {};
      for (const key of perBookOverrideKeys) {
        if (previous[key] !== next[key]) {
          changedOverrides[perBookSettingKeys[key]] = String(next[key]);
        }
      }
      scheduleBookSettingsSave(bookId, changedOverrides);
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
  }, [bookId, scheduleBookSettingsSave, scheduleReaderPreferenceSave, settingsLoadedBookRef]);

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
    const stored: StoredReaderSettings = { ...readerSettings };
    // The override keys live in `book_settings` now, and the global-only keys live
    // in the `settings` table; a copy of either in the blob is only a stale second
    // source of truth. What is left is the per-book state with nowhere else to go:
    // `charSpacing` and the four marker toggles (plus `margins` / `customTheme`,
    // whose blob copies are already merged global-first).
    for (const key of perBookOverrideKeys) delete stored[key];
    for (const key of globalOnlySettingKeys) delete stored[key];
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
