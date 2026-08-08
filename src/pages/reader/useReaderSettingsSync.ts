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
} from "../../components/reader-bindings.ts";
import {
  applySettingsChange,
  listenForSettingsChanged,
  notifySettingsChanged,
  type SettingsChangedValues,
} from "../../components/settings-events.ts";
import {
  diffBookOverrides,
  isPromotionUndoable,
  perBookSettingKeys,
  type PerBookReaderSettings,
  type ReaderSettingsPromotionUndo,
} from "./reader-settings-scope.ts";

// Exported so the handful of places that need to write one of these settings
// outside a full diff — the chapter-end hint's own "don't show again", which
// fires from inside useFoliateAnnotations.ts rather than from a settings-panel
// save — read the same key this file writes, instead of a second literal that
// could drift from it.
export const readerPreferenceSettingKeys = {
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
  chapterEndReviewHint: "chapter_end_review_hint",
  bookFinishedHint: "book_finished_hint",
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
// The marker toggles were the exception for a while — no global counterpart,
// so a row was the only place the choice could live, and 「设为全局默认」 quietly
// vanished for a book whose only overrides were markers. They now have a global
// layer like everything else; a book with no row follows it, and with no global
// row either, `DEFAULT_MARKER_VISIBILITY`. They used to sit in the
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

/**
 * What an absent marker row means, at both layers. Exported so the Settings
 * page's copy in `mark-palette.ts` can be pinned equal to it by test rather
 * than by hope: every install predating the global layer has all three rows
 * missing, so the two disagreeing would change what those users see.
 */
export const DEFAULT_MARKER_VISIBILITY = {
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
} as const;

/**
 * The reader's out-of-the-box state, and the single source of default values.
 * Exported so Settings → Reading's 「restore defaults」 writes exactly these
 * rather than keeping a second copy of the same numbers.
 */
export function createDefaultReaderSettings(): ReaderSettingsState {
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
    // 0% reads too tight in the two-page layout, the default `pageColumns`
    // above — 4% gives the gutter and outer edges some breathing room without
    // asking a fresh install to tune it first.
    margins: 4,
    ...DEFAULT_MARKER_VISIBILITY,
    chapterEndReviewHint: true,
    bookFinishedHint: true,
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
    // Global-only, same as the three toggles above: no per-book row, because a
    // per-book override would need `commands/settings.rs`'s promotion map to
    // know about it too, and this setting has no reason to vary by book anyway.
    chapterEndReviewHint: booleanSetting(globalSettings.chapter_end_review_hint, previous.chapterEndReviewHint),
    // Same shape as the chapter-end line's own setting: global-only, no
    // per-book row, and no settings-panel toggle — §2.2's spec asks only for
    // a "don't show again" exit on the line itself, which writes this key
    // directly (see `dismissBookFinishedHint` in `useFoliateAnnotations.ts`).
    bookFinishedHint: booleanSetting(globalSettings.book_finished_hint, previous.bookFinishedHint),
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
    // Marker visibility resolves per-book → global → default, like everything
    // else. The global row is allowed to be absent — that is the state every
    // existing install upgrades into, and it must land on exactly the same
    // values the hardcoded defaults gave before the global layer existed.
    // `previous` is deliberately not in the chain: these used to leak between
    // books through it, and the canonical default is what a book with no row of
    // its own is entitled to.
    showLookupMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showLookupMarkers],
      booleanSetting(globalSettings.show_lookup_markers, DEFAULT_MARKER_VISIBILITY.showLookupMarkers),
    ),
    showNewVocabMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showNewVocabMarkers],
      booleanSetting(globalSettings.show_new_vocab_markers, DEFAULT_MARKER_VISIBILITY.showNewVocabMarkers),
    ),
    showLearningMarkers: booleanSetting(
      perBookSettings[perBookSettingKeys.showLearningMarkers],
      booleanSetting(globalSettings.show_learning_markers, DEFAULT_MARKER_VISIBILITY.showLearningMarkers),
    ),
  };
}

// Pure orchestration for the debounced per-book settings write, pulled out of the
// hook so the race between a flush and a concurrent restore/delete is directly
// testable without a React renderer (this repo's test runner is plain
// `node:test`, with no DOM/hook-rendering harness).
//
// `pending` is mutated in place — it is meant to be a hook's ref contents — and
// its ownership of a book id is the only signal the rest of the module has for
// "a write for this book is still outstanding". That is why an entry is deleted
// only once its own `invokeSetBulk` call has resolved, never up front: clearing
// it before the await would make a concurrent reader (`restoreBookSettingsKeys`)
// believe nothing is in flight while the write is still on the wire.
export async function flushPendingBookSettings(
  pending: Record<string, Record<string, string>>,
  invokeSetBulk: (bookId: string, settings: Record<string, string>) => Promise<unknown>,
  throwOnError = false,
): Promise<void> {
  const bookEntries = Object.entries(pending);
  let failed = false;
  for (const [book, values] of bookEntries) {
    try {
      await invokeSetBulk(book, values);
      // Only clear if no newer edit was queued for this book while we awaited
      // above (reference equality: the scheduler always replaces the object, so
      // a still-`===` entry means nothing new arrived during the await).
      if (pending[book] === values) {
        delete pending[book];
      }
    } catch {
      failed = true;
      // Keep the edit queued for the next settle, letting newer values win.
      pending[book] = {
        ...values,
        ...pending[book],
      };
    }
  }
  if (failed && throwOnError) throw new Error("BOOK_SETTINGS_SAVE_FAILED");
}

// Settles any write still in flight for `bookId` before deleting `keys`, so the
// two IPCs cannot land out of order (an in-flight bulk write landing after the
// delete would re-insert the row the caller just asked to remove, and clear the
// deletion tombstone with it). `flush` is expected to be a call that resolves
// once `pending`'s outstanding entry for `bookId`, if any, has settled.
export async function restoreBookSettingsKeys(
  bookId: string,
  keys: string[],
  pending: Record<string, Record<string, string>>,
  invokeDelete: (bookId: string, keys: string[]) => Promise<Record<string, string>>,
  flush: () => Promise<void>,
  onDeleteFailed?: (pendingDeleted: Record<string, string>) => void,
): Promise<Record<string, string>> {
  await flush();
  const inFlight = pending[bookId];
  const pendingDeleted: Record<string, string> = {};
  if (inFlight) {
    for (const key of keys) {
      if (inFlight[key] !== undefined) pendingDeleted[key] = inFlight[key];
      delete inFlight[key];
    }
    if (Object.keys(inFlight).length === 0) delete pending[bookId];
  }
  let deleted: Record<string, string>;
  try {
    deleted = await invokeDelete(bookId, keys);
  } catch (error) {
    onDeleteFailed?.(pendingDeleted);
    throw error;
  }
  return { ...deleted, ...pendingDeleted };
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
  /**
   * `onUndoAvailable` receives everything the promotion displaced, for the undo
   * affordance to hold and hand back to `undoPromoteBookOverrides`. It is an
   * optional trailing parameter rather than part of the return value so that
   * callers that do not offer an undo keep the old call shape unchanged.
   */
  promoteBookOverrides(
    selectedBookIds: string[],
    onUndoAvailable?: (undo: ReaderSettingsPromotionUndo) => void,
  ): Promise<Record<string, string>>;
  undoPromoteBookOverrides(undo: ReaderSettingsPromotionUndo): Promise<void>;
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
  // Same shape, for keys a settings-panel edit just brought back in line with
  // the global value — see `diffBookOverrides` and `flushBookSettings`.
  const pendingBookDeletesRef = useRef<Record<string, Set<string>>>({});

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
  //
  // Deletions ride the same timer and the same flush: a key that stops
  // overriding (its value now matches global — see `diffBookOverrides`) is
  // queued in `pendingBookDeletesRef` instead of `pendingBookSettingsRef`, and
  // `scheduleBookSettingsSave`/`scheduleBookSettingsDelete` keep a key out of
  // whichever queue it just left, so the two queues never disagree about the
  // same row at flush time.
  const flushBookSettings = useCallback(
    (throwOnError = false) => {
      bookSaveTimerRef.current = null;
      const deleteEntries = Object.entries(pendingBookDeletesRef.current);
      pendingBookDeletesRef.current = {};
      const deletesSettled = (async () => {
        let failed = false;
        for (const [book, keys] of deleteEntries) {
          if (keys.size === 0) continue;
          try {
            await invoke("delete_book_settings", { bookId: book, keys: [...keys] });
          } catch {
            failed = true;
            const requeued = pendingBookDeletesRef.current[book] ?? new Set<string>();
            for (const key of keys) requeued.add(key);
            pendingBookDeletesRef.current[book] = requeued;
          }
        }
        if (failed && throwOnError) throw new Error("BOOK_SETTINGS_DELETE_FAILED");
      })();
      const writesSettled = flushPendingBookSettings(
        pendingBookSettingsRef.current,
        (book, values) => invoke("set_book_settings_bulk", { bookId: book, settings: values }),
        throwOnError,
      );
      return Promise.all([writesSettled, deletesSettled]).then(() => {});
    },
    [],
  );

  const scheduleBookSettingsSave = useCallback((book: string, values: Record<string, string>) => {
    if (Object.keys(values).length === 0) return;
    pendingBookSettingsRef.current[book] = {
      ...pendingBookSettingsRef.current[book],
      ...values,
    };
    // A key just written no longer needs the deletion queued for it moments
    // ago in the same debounce window — the newer edit wins.
    const queuedDeletes = pendingBookDeletesRef.current[book];
    if (queuedDeletes) for (const key of Object.keys(values)) queuedDeletes.delete(key);
    if (bookSaveTimerRef.current !== null) window.clearTimeout(bookSaveTimerRef.current);
    bookSaveTimerRef.current = window.setTimeout(() => {
      void flushBookSettings();
    }, 400);
  }, [flushBookSettings]);

  const scheduleBookSettingsDelete = useCallback((book: string, keys: string[]) => {
    if (keys.length === 0) return;
    const current = pendingBookDeletesRef.current[book] ?? new Set<string>();
    for (const key of keys) current.add(key);
    pendingBookDeletesRef.current[book] = current;
    // Same reasoning in reverse: a key about to be deleted must not also carry
    // a stale queued write from before it matched the global value.
    const queuedWrite = pendingBookSettingsRef.current[book];
    if (queuedWrite) for (const key of keys) delete queuedWrite[key];
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
      // Compared against the global value, not just against `previous`: a key
      // set back to exactly what global already holds should stop overriding
      // rather than store an identical row (see `diffBookOverrides`) — that
      // identical row was what left the scope panel reporting a book-specific
      // override that had nothing left to be specific about.
      const globalResolved = resolveReaderSettings(createDefaultReaderSettings(), globalSettingsRef.current);
      const { toWrite, toDelete } = diffBookOverrides(previous, next, globalResolved, bookOverridesRef.current);
      if (Object.keys(toWrite).length > 0 || toDelete.length > 0) {
        setBookOverrides((current) => {
          const updated = { ...current, ...toWrite };
          for (const key of toDelete) delete updated[key];
          bookOverridesRef.current = updated;
          return updated;
        });
      }
      scheduleBookSettingsSave(bookId, toWrite);
      scheduleBookSettingsDelete(bookId, toDelete);
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
    if (previous.chapterEndReviewHint !== next.chapterEndReviewHint) changed[readerPreferenceSettingKeys.chapterEndReviewHint] = String(next.chapterEndReviewHint);
    scheduleReaderPreferenceSave(changed);
  }, [bookId, scheduleBookSettingsSave, scheduleBookSettingsDelete, scheduleReaderPreferenceSave, settingsLoadedBookRef]);

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
    const result = await restoreBookSettingsKeys(
      bookId,
      keys,
      pendingBookSettingsRef.current,
      (book, deleteKeys) => invoke<Record<string, string>>("delete_book_settings", { bookId: book, keys: deleteKeys }),
      () => flushBookSettings(true),
      (pendingDeleted) => scheduleBookSettingsSave(bookId, pendingDeleted),
    );
    const remaining = { ...bookOverridesRef.current };
    for (const key of keys) delete remaining[key];
    applySources(globalSettingsRef.current, remaining);
    return result;
  }, [applySources, bookId, flushBookSettings, scheduleBookSettingsSave]);

  const undoRestoreBookOverrides = useCallback(async (values: Record<string, string>) => {
    if (!bookId || Object.keys(values).length === 0) return;
    await invoke("set_book_settings_bulk", { bookId, settings: values });
    applySources(globalSettingsRef.current, { ...bookOverrides, ...values });
  }, [applySources, bookId, bookOverrides]);

  const promoteBookOverrides = useCallback(async (
    selectedBookIds: string[],
    onUndoAvailable?: (undo: ReaderSettingsPromotionUndo) => void,
  ) => {
    if (!bookId) return {};
    await flushBookSettings(true);
    const result = await invoke<{
      settings: Record<string, string>;
      promoted_keys: string[];
      undo: ReaderSettingsPromotionUndo;
    }>(
      "promote_book_settings_to_global",
      { sourceBookId: bookId, selectedBookIds },
    );
    const remaining = { ...bookOverridesRef.current };
    for (const key of result.promoted_keys) delete remaining[key];
    const globals = { ...globalSettingsRef.current, ...result.settings };
    applySources(globals, remaining);
    await notifySettingsChanged(result.settings).catch(() => {});
    if (isPromotionUndoable(result.undo)) onUndoAvailable?.(result.undo);
    return result.settings;
  }, [applySources, bookId, flushBookSettings]);

  // The inverse of the call above, replayed from the payload it handed out.
  // The backend restores the rows; this puts the same values back into the two
  // in-memory sources so the panel does not have to wait for a reload.
  const undoPromoteBookOverrides = useCallback(async (undo: ReaderSettingsPromotionUndo) => {
    if (!isPromotionUndoable(undo)) return;
    await invoke("undo_promote_book_settings", { undo });
    const globals = { ...globalSettingsRef.current };
    // Every key the undo touched is broadcast, deletions included: `null` says
    // "this row went away", which is the same thing the backend now puts on the
    // wire as a `setting` tombstone. Without it another open reader window
    // would keep showing the promoted value until it reloaded.
    const broadcast: SettingsChangedValues = {};
    for (const [key, value] of Object.entries(undo.globals)) {
      // `null` means the key had no row before the promotion. Dropping it here
      // is what lets `resolveReaderSettings` fall through to the default again.
      if (value === null) delete globals[key];
      else globals[key] = value;
      broadcast[key] = value;
    }
    const overrides = { ...bookOverridesRef.current };
    for (const row of undo.book_settings) {
      if (row.book_id === bookId) overrides[row.key] = row.value;
    }
    applySources(globals, overrides);
    await notifySettingsChanged(broadcast).catch(() => {});
  }, [applySources, bookId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (disposed) return;
      globalSettingsRef.current = applySettingsChange(globalSettingsRef.current, values);
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
    undoPromoteBookOverrides,
  };
}
