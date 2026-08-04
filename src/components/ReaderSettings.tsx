import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronLeft, ChevronRight, ScrollText, BookOpen, File, Files, Keyboard, Loader2, MousePointer2, Search, Trash2 } from "lucide-react";
import Toggle from "./ui/Toggle";
import Select from "./ui/Select";
import {
  bindingFromKeyboardEvent,
  bindingFromMouseEvent,
  formatPageTurnBinding,
} from "./page-turn-bindings";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getReaderFontOptions,
  getReaderThemes,
  type ReaderCapabilities,
  type ReaderFont,
  type ReaderCustomTheme,
  type ReaderTheme,
} from "./reader-settings";
import {
  filterReaderSettingConflicts,
  overriddenStateKeys,
  perBookSettingKeys,
  promotableRows,
  toggleVisibleConflictSelection,
  type PerBookOverrideKey,
  type PerBookReaderSettings,
  type ReaderSettingConflict,
} from "../pages/reader/reader-settings-scope";

const sliderClass =
  "w-full h-1 cursor-pointer appearance-none rounded-full bg-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bg-surface [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:shadow-sm";

export type ReadingMode = "scrolling" | "paginated";
export type PageColumns = 1 | 2;
export type PageTurnAnimation = "none" | "slide" | "fade" | "cover";
export type ParagraphSpacing = "original" | "none" | "compact" | "comfortable" | "loose";

export interface ReaderSettingsState {
  theme: ReaderTheme;
  customTheme: ReaderCustomTheme;
  font: ReaderFont;
  fontSize: number; // px
  narrowFontShrink: boolean; // shrink the rendered size when the column is too narrow
  readingMode: ReadingMode;
  pageColumns: PageColumns; // 1 = single page, 2 = two pages side by side
  pageTurnAnimation: PageTurnAnimation;
  showChapterProgress: boolean;
  showBookProgress: boolean;
  showPageNumbers: boolean;
  previousPageBinding: string;
  nextPageBinding: string;
  lineSpacing: number; // multiplier, e.g. 1.5
  charSpacing: number; // percentage, 0 = normal
  wordSpacing: number; // percentage, 0 = normal
  textJustification: boolean;
  paragraphSpacing: ParagraphSpacing;
  firstLineIndent: boolean;
  margins: number; // percentage of the available reading width
  showLookupMarkers: boolean;
  showNewVocabMarkers: boolean;
  showLearningMarkers: boolean;
  showMasteredMarkers: boolean;
}

interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  settings: ReaderSettingsState;
  globalSettings: ReaderSettingsState;
  onSettingsChange: (settings: ReaderSettingsState) => void;
  capabilities: ReaderCapabilities;
  onClearLookupMarks?: () => Promise<void>;
  bookId?: string;
  bookOverrides?: PerBookReaderSettings;
  onRestoreBookOverrides?: (keys: string[]) => Promise<Record<string, string>>;
  onUndoRestoreBookOverrides?: (values: Record<string, string>) => Promise<void>;
  onPromoteBookOverrides?: (selectedBookIds: string[]) => Promise<Record<string, string>>;
}

export type BindingDirection = "previous" | "next";

export function PageTurnBindingButton({
  direction,
  value,
  active,
  onActivate,
  onChange,
}: {
  direction: BindingDirection;
  value: string;
  active: boolean;
  onActivate: (direction: BindingDirection | null) => void;
  onChange: (value: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const suppressContextMenuUntilRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onActivate(null);
        return;
      }
      const binding = bindingFromKeyboardEvent(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      onChange(binding);
      onActivate(null);
    };
    const onMouseDown = (event: MouseEvent) => {
      const binding = bindingFromMouseEvent(event);
      if (!binding) return;
      if (event.button === 2) suppressContextMenuUntilRef.current = Date.now() + 800;
      event.preventDefault();
      event.stopPropagation();
      onChange(binding);
      onActivate(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [active, onActivate, onChange]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!active && Date.now() > suppressContextMenuUntilRef.current) return;
      suppressContextMenuUntilRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [active]);

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onActivate(active ? null : direction)}
      className={`inline-flex h-8 min-w-[92px] items-center justify-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors ${
        active
          ? "border-accent bg-accent-bg text-accent-text"
          : "border-border bg-bg-input text-text-secondary hover:border-accent/50"
      }`}
    >
      {value.startsWith("mouse:") ? <MousePointer2 size={13} /> : <Keyboard size={13} />}
      <span>{active ? t("readerSettings.pressBinding") : formatPageTurnBinding(value, i18n.language)}</span>
    </button>
  );
}

export default function ReaderSettings({
  open,
  onClose,
  anchorRef,
  settings,
  globalSettings,
  onSettingsChange,
  capabilities,
  onClearLookupMarks,
  bookId,
  bookOverrides = {},
  onRestoreBookOverrides,
  onUndoRestoreBookOverrides,
  onPromoteBookOverrides,
}: ReaderSettingsProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 8, maxHeight: 0 });
  const [clearLookupConfirm, setClearLookupConfirm] = useState(false);
  const [clearLookupBusy, setClearLookupBusy] = useState(false);
  const [clearLookupError, setClearLookupError] = useState(false);
  const [capturingBinding, setCapturingBinding] = useState<BindingDirection | null>(null);
  const [scopeView, setScopeView] = useState<"main" | "manage" | "confirm" | "choose">("main");
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState(false);
  const [conflicts, setConflicts] = useState<ReaderSettingConflict[]>([]);
  const [conflictQuery, setConflictQuery] = useState("");
  const [selectedConflictIds, setSelectedConflictIds] = useState<Set<string>>(() => new Set());
  const [undoValues, setUndoValues] = useState<Record<string, string> | null>(null);
  const [undoLabel, setUndoLabel] = useState("");

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const top = Math.max(8, rect.bottom + 4);
      const maxRight = Math.max(8, window.innerWidth - 320 - 8);
      setPosition({
        top,
        right: Math.max(8, Math.min(window.innerWidth - rect.right, maxRight)),
        maxHeight: Math.max(0, Math.min(760, window.innerHeight - top - 8)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (open) return;
    setClearLookupConfirm(false);
    setClearLookupError(false);
    setCapturingBinding(null);
    setScopeView("main");
    setScopeError(false);
    setConflictQuery("");
    setSelectedConflictIds(new Set());
  }, [open]);

  const update = useCallback((partial: Partial<ReaderSettingsState>) => {
    onSettingsChange({ ...settings, ...partial });
  }, [onSettingsChange, settings]);

  const overrideStateKeys = overriddenStateKeys(bookOverrides);
  const promotableKeys = promotableRows(bookOverrides);
  const visibleConflicts = filterReaderSettingConflicts(conflicts, conflictQuery);

  const restoreOverrides = useCallback(async (keys: string[], label: string) => {
    if (!onRestoreBookOverrides || keys.length === 0) return;
    setScopeBusy(true);
    setScopeError(false);
    try {
      const deleted = await onRestoreBookOverrides(keys);
      setUndoValues(deleted);
      setUndoLabel(label);
      setScopeView("main");
    } catch {
      setScopeError(true);
    } finally {
      setScopeBusy(false);
    }
  }, [onRestoreBookOverrides]);

  const openPromotion = useCallback(async () => {
    if (!bookId || promotableKeys.length === 0) return;
    setScopeBusy(true);
    setScopeError(false);
    try {
      const next = await invoke<ReaderSettingConflict[]>("list_reader_setting_conflicts", {
        sourceBookId: bookId,
        keys: promotableKeys,
      });
      setConflicts(next);
      setSelectedConflictIds(new Set());
      setConflictQuery("");
      setScopeView("confirm");
    } catch {
      setScopeError(true);
    } finally {
      setScopeBusy(false);
    }
  }, [bookId, promotableKeys]);

  const promoteOverrides = useCallback(async () => {
    if (!onPromoteBookOverrides) return;
    setScopeBusy(true);
    setScopeError(false);
    try {
      await onPromoteBookOverrides([...selectedConflictIds]);
      setUndoValues(null);
      setScopeView("main");
    } catch {
      setScopeError(true);
    } finally {
      setScopeBusy(false);
    }
  }, [onPromoteBookOverrides, selectedConflictIds]);

  const themeLabels: Record<string, string> = {
    original: t("readerSettings.themeOriginal"),
    paper: t("readerSettings.themeSepia"),
    quiet: t("readerSettings.themeGray"),
    dark: t("readerSettings.themeDark"),
    custom: t("readerSettings.themeCustom"),
  };

  const settingLabel = (key: PerBookOverrideKey) => t(`readerSettings.scope.settings.${key}`);
  const settingValue = (key: PerBookOverrideKey, source = settings) => {
    const value = source[key];
    if (typeof value === "boolean") return t(value ? "common.on" : "common.off");
    if (key === "theme") return themeLabels[String(value)] ?? String(value);
    if (key === "font") {
      return getReaderFontOptions(String(value), t("readerSettings.fontUnavailable"))
        .find((option) => option.value === value)?.label ?? String(value);
    }
    if (key === "readingMode") return t(value === "scrolling" ? "readerSettings.scrolling" : "readerSettings.pageTurning");
    if (key === "pageColumns") return t(value === 1 ? "readerSettings.singlePage" : "readerSettings.twoPages");
    if (key === "paragraphSpacing") {
      return value === "original"
        ? t("readerSettings.publisherDefault")
        : t(`readerSettings.paragraphSpacing.${value}`);
    }
    if (key === "fontSize") return `${value}px`;
    if (key === "charSpacing" || key === "wordSpacing" || key === "margins") return `${value}%`;
    if (key === "lineSpacing") return `${value}×`;
    return String(value);
  };
  const overrideNote = (key: PerBookOverrideKey) => (
    bookOverrides[perBookSettingKeys[key]] !== undefined ? (
      <div className="mt-1.5 flex items-center gap-1 text-[11px] text-accent-text">
        <span className="size-1 rounded-full bg-accent" aria-hidden="true" />
        <span>{t("readerSettings.scope.bookSpecific")}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          disabled={scopeBusy}
          className="underline decoration-accent underline-offset-2 hover:text-accent disabled:opacity-50"
          onClick={() => void restoreOverrides(
            [perBookSettingKeys[key]],
            t("readerSettings.scope.restoredOne", { setting: settingLabel(key) }),
          )}
        >
          {t("readerSettings.scope.followGlobal")}
        </button>
      </div>
    ) : null
  );

  if (!open) return null;

  if (scopeView !== "main") {
    const selectedCount = selectedConflictIds.size;
    const allVisibleSelected = visibleConflicts.length > 0
      && visibleConflicts.every((conflict) => selectedConflictIds.has(conflict.id));
    return (
      <div
        ref={popoverRef}
        data-reader-settings
        className="fixed z-50 flex w-[320px] max-w-[calc(100dvw-16px)] flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-popover"
        style={{ top: position.top, right: position.right, height: position.maxHeight, maxHeight: position.maxHeight }}
      >
        <div className="flex h-12 shrink-0 items-center border-b border-border-light px-3">
          <button
            type="button"
            className="mr-1 flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"
            onClick={() => setScopeView(scopeView === "manage" ? "main" : scopeView === "confirm" ? "manage" : "confirm")}
            aria-label={t("common.back")}
          >
            <ChevronLeft size={17} />
          </button>
          <h2 className="text-[13px] font-medium text-text-primary">
            {t(`readerSettings.scope.${scopeView}Title`)}
          </h2>
          <button
            type="button"
            className="ml-auto flex size-8 items-center justify-center rounded-md text-[18px] text-text-muted hover:bg-bg-input"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </div>

        {scopeView === "manage" && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="rounded-lg bg-accent-bg p-3">
              <p className="text-[13px] font-medium text-text-primary">
                {t("readerSettings.scope.overrideCount", { count: overrideStateKeys.length })}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">{t("readerSettings.scope.manageHint")}</p>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              {overrideStateKeys.map((key) => (
                <div key={key} className="flex items-center justify-between gap-3 border-t border-border-light px-3 py-2.5 first:border-t-0">
                  <span className="text-[12px] font-medium text-text-primary">{settingLabel(key)}</span>
                  <span className="max-w-[170px] text-right text-[11px] leading-4">
                    <span className="block truncate text-text-muted">
                      {t(promotableKeys.includes(perBookSettingKeys[key])
                        ? "readerSettings.scope.globalValue"
                        : "readerSettings.scope.defaultValue")}: {settingValue(key, globalSettings)}
                    </span>
                    <span className="block truncate text-accent-text">
                      {t("readerSettings.scope.bookValue")}: {settingValue(key)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {promotableKeys.length > 0 && (
                <button
                  type="button"
                  disabled={scopeBusy}
                  className="flex w-full items-center rounded-lg border border-border px-3 py-3 text-left hover:bg-bg-input disabled:opacity-50"
                  onClick={() => void openPromotion()}
                >
                  <span><strong className="block text-[12px] font-medium">{t("readerSettings.scope.promote", { count: promotableKeys.length })}</strong><span className="mt-1 block text-[11px] text-text-muted">{t("readerSettings.scope.promoteHint")}</span></span>
                  {scopeBusy ? <Loader2 className="ml-auto animate-spin" size={15} /> : <ChevronRight className="ml-auto text-text-muted" size={16} />}
                </button>
              )}
              <button
                type="button"
                disabled={scopeBusy}
                className="flex w-full items-center rounded-lg border border-border px-3 py-3 text-left hover:bg-bg-input disabled:opacity-50"
                onClick={() => void restoreOverrides(
                  overrideStateKeys.map((key) => perBookSettingKeys[key]),
                  t("readerSettings.scope.restoredAll"),
                )}
              >
                <span><strong className="block text-[12px] font-medium">{t("readerSettings.scope.restoreAll")}</strong><span className="mt-1 block text-[11px] text-text-muted">{t("readerSettings.scope.restoreAllHint")}</span></span>
                <ChevronRight className="ml-auto text-text-muted" size={16} />
              </button>
            </div>
            {scopeError && <p role="alert" className="mt-3 text-[11px] text-danger-text">{t("readerSettings.scope.actionFailed")}</p>}
          </div>
        )}

        {scopeView === "confirm" && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="flex size-9 items-center justify-center rounded-full bg-accent-bg text-accent"><Check size={17} /></div>
            <h3 className="mt-3 text-[15px] font-medium text-text-primary">{t("readerSettings.scope.confirmHeading")}</h3>
            <p className="mt-1.5 text-[11px] leading-4 text-text-muted">{t("readerSettings.scope.confirmHint", { count: promotableKeys.length })}</p>
            <div className="mt-3 rounded-lg bg-bg-input px-3 py-2.5 text-[11px] leading-5 text-text-secondary">
              {overrideStateKeys.filter((key) => promotableKeys.includes(perBookSettingKeys[key])).map((key) => (
                <div key={key} className="flex justify-between gap-3"><span>{settingLabel(key)}</span><span className="truncate text-text-primary">{settingValue(key)}</span></div>
              ))}
            </div>
            {conflicts.length > 0 && (
              <button
                type="button"
                className="mt-3 flex w-full items-center rounded-lg border border-border px-3 py-3 text-left hover:bg-bg-input"
                onClick={() => setScopeView("choose")}
              >
                <span><strong className="block text-[12px] font-medium">{t("readerSettings.scope.extraApply")}</strong><span className="mt-1 block text-[11px] text-text-muted">{selectedCount > 0 ? t("readerSettings.scope.selectedBooks", { count: selectedCount }) : t("readerSettings.scope.keepOthers")}</span></span>
                <ChevronRight className="ml-auto text-text-muted" size={16} />
              </button>
            )}
            <p className="mt-3 rounded-lg border border-accent/20 bg-accent-bg px-3 py-2.5 text-[11px] leading-4 text-text-muted">
              {selectedCount > 0
                ? t("readerSettings.scope.impactSelected", { count: selectedCount })
                : t("readerSettings.scope.impactDefault", { count: conflicts.length })}
            </p>
            {scopeError && <p role="alert" className="mt-3 text-[11px] text-danger-text">{t("readerSettings.scope.actionFailed")}</p>}
            <div className="mt-4 flex gap-2">
              <button type="button" className="h-9 flex-1 rounded-md border border-border text-[12px] hover:bg-bg-input" onClick={() => setScopeView("manage")}>{t("common.back")}</button>
              <button type="button" disabled={scopeBusy} className="h-9 flex-1 rounded-md bg-accent px-2 text-[12px] font-medium text-white disabled:opacity-50" onClick={() => void promoteOverrides()}>
                {scopeBusy ? <Loader2 className="mx-auto animate-spin" size={15} /> : t("readerSettings.scope.confirmPromote")}
              </button>
            </div>
          </div>
        )}

        {scopeView === "choose" && (
          <>
            <div className="shrink-0 border-b border-border-light bg-bg-surface px-3 pb-2.5 pt-3">
              <h3 className="text-[13px] font-medium text-text-primary">{t("readerSettings.scope.chooseHeading", { count: promotableKeys.length })}</h3>
              <p className="mt-1 text-[11px] leading-4 text-text-muted">{t("readerSettings.scope.chooseHint")}</p>
              {conflicts.length >= 6 && (
                <>
                  <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-border bg-bg-input px-2.5 focus-within:border-accent">
                    <Search size={14} className="text-text-muted" />
                    <input value={conflictQuery} onChange={(event) => setConflictQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none" placeholder={t("readerSettings.scope.searchBooks")} />
                  </label>
                  <div className="mt-2 flex items-center text-[11px]">
                    <span className="text-text-muted">{conflictQuery.trim() ? t("readerSettings.scope.searchResults", { count: visibleConflicts.length }) : t("readerSettings.scope.conflictCount", { count: conflicts.length })}</span>
                    <button
                      type="button"
                      disabled={visibleConflicts.length === 0}
                      className="ml-auto font-medium text-accent-text disabled:opacity-40"
                      onClick={() => setSelectedConflictIds((current) => toggleVisibleConflictSelection(current, visibleConflicts))}
                    >
                      {allVisibleSelected
                        ? t("readerSettings.scope.unselectVisible", { count: visibleConflicts.length })
                        : conflictQuery.trim()
                          ? t("readerSettings.scope.selectVisible", { count: visibleConflicts.length })
                          : t("readerSettings.scope.selectAll", { count: conflicts.length })}
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 py-2 [scrollbar-gutter:stable]">
              {visibleConflicts.map((conflict) => {
                const selected = selectedConflictIds.has(conflict.id);
                return (
                  <button
                    key={conflict.id}
                    type="button"
                    aria-pressed={selected}
                    className={`mb-2 flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left ${selected ? "border-accent bg-accent-bg" : "border-border hover:bg-bg-input"}`}
                    onClick={() => setSelectedConflictIds((current) => {
                      const next = new Set(current);
                      if (next.has(conflict.id)) next.delete(conflict.id);
                      else next.add(conflict.id);
                      return next;
                    })}
                  >
                    <span className="min-w-0 flex-1"><strong className="block truncate text-[12px] font-medium text-text-primary">{conflict.title}</strong><span className="mt-1 block truncate text-[11px] text-text-muted">{conflict.author || t("common.unknownAuthor")} · {t("readerSettings.scope.keysWillUpdate", { count: conflict.conflicting_keys.length })}</span></span>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${selected ? "bg-accent text-white" : "bg-bg-input text-text-muted"}`}>{t(selected ? "readerSettings.scope.willUpdate" : "readerSettings.scope.keepOriginal")}</span>
                  </button>
                );
              })}
              {visibleConflicts.length === 0 && <p className="py-8 text-center text-[12px] text-text-muted">{t("readerSettings.scope.noSearchResults")}</p>}
            </div>
            <div className="shrink-0 border-t border-border bg-bg-surface px-4 pb-3 pt-2.5 shadow-[0_-8px_20px_rgba(0,0,0,0.04)]">
              <p className="mb-2 text-center text-[11px] text-text-muted">{selectedCount > 0 ? t("readerSettings.scope.selectionTotal", { selected: selectedCount, total: conflicts.length }) : t("readerSettings.scope.noneSelected")}</p>
              <button type="button" className="h-9 w-full rounded-md bg-accent text-[12px] font-medium text-white" onClick={() => setScopeView("confirm")}>{t("readerSettings.scope.confirmSelection", { count: selectedCount })}</button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={popoverRef}
      data-reader-settings
      className="fixed z-50 flex w-[320px] max-w-[calc(100dvw-16px)] flex-col overflow-y-auto rounded-lg border border-border bg-bg-surface shadow-popover"
      style={{ top: position.top, right: position.right, maxHeight: position.maxHeight }}
    >
      {overrideStateKeys.length > 0 ? (
        <button
          type="button"
          className="m-3 mb-0 flex shrink-0 items-center gap-2 rounded-lg border border-accent/25 bg-accent-bg px-3 py-2.5 text-left hover:border-accent/40"
          onClick={() => setScopeView("manage")}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-accent" />
          <span className="min-w-0"><strong className="block text-[12px] font-medium text-text-primary">{t("readerSettings.scope.overrideCount", { count: overrideStateKeys.length })}</strong><span className="mt-0.5 block text-[11px] text-text-muted">{t("readerSettings.scope.summaryHint")}</span></span>
          <ChevronRight className="ml-auto shrink-0 text-text-muted" size={16} />
        </button>
      ) : (
        <div className="m-3 mb-0 flex shrink-0 items-start gap-2 rounded-lg bg-bg-input px-3 py-2.5">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-text-muted" />
          <span><strong className="block text-[12px] font-medium text-text-primary">{t("readerSettings.scope.followingAll")}</strong><span className="mt-0.5 block text-[11px] leading-4 text-text-muted">{t("readerSettings.scope.followingAllHint")}</span></span>
        </div>
      )}
      {/* Font size toggle */}
      {capabilities.supportsReflowSettings && (<div className="border-b border-border-light px-4 py-2">
        <div className="flex h-[44px] items-center">
        <button
          onClick={() => update({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 2) })}
          className="flex-1 flex items-center justify-center h-7 border-r border-border cursor-pointer text-text-primary hover:bg-bg-input"
        >
          <span className="text-[14px] font-medium">A-</span>
        </button>
        <span className="flex-1 flex items-center justify-center text-[14px] font-medium text-text-primary">
          {settings.fontSize}px
        </span>
        <button
          onClick={() => update({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 2) })}
          className="flex-1 flex items-center justify-center h-9 border-l border-border cursor-pointer text-text-primary hover:bg-bg-input"
        >
          <span className="text-[20px] font-medium tracking-[-0.45px]">A+</span>
        </button>
        </div>
        {overrideNote("fontSize")}
      </div>)}

      {/* Theme selector */}
      <div className={`flex items-center justify-center gap-5 h-[78px] ${capabilities.supportsReflowSettings ? "border-b border-border-light" : ""}`}>
        {getReaderThemes().map((theme) => (
          <button
            key={theme.id}
            onClick={() => update({ theme: theme.id })}
            className="flex flex-col items-center gap-1.5 cursor-pointer"
          >
            <div
              className={`size-8 rounded-full ${theme.color} flex items-center justify-center ${
                settings.theme === theme.id ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""
              }`}
              style={theme.id === "custom" ? { backgroundColor: settings.customTheme.color } : undefined}
            >
              {settings.theme === theme.id && (
                <Check
                  size={14}
                  className={theme.id === "dark" || theme.id === "quiet" ? "text-white" : "text-accent"}
                />
              )}
            </div>
            <span className="text-[10px] font-medium text-text-muted tracking-[0.12px]">
              {themeLabels[theme.id]}
            </span>
          </button>
        ))}
      </div>
      {bookOverrides[perBookSettingKeys.theme] !== undefined && (
        <div className="-mt-1 border-b border-border-light px-4 pb-2">{overrideNote("theme")}</div>
      )}

      {/* Font family — hidden for PDFs */}
      {capabilities.supportsReflowSettings && (
      <div className="px-4 py-3 border-b border-border-light">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase mb-2">{t("readerSettings.font")}</p>
        <Select
          value={settings.font}
          onChange={(v) => update({ font: v as ReaderFont })}
          options={getReaderFontOptions(settings.font, t("readerSettings.fontUnavailable"))}
        />
        {overrideNote("font")}
      </div>
      )}

      {capabilities.supportsContinuousScroll && (<div className="px-4 py-3 border-b border-border-light">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase mb-2">{t("readerSettings.readingMode")}</p>
        <div className="flex gap-2">
          <button
            onClick={() => update({ readingMode: "scrolling" })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.readingMode === "scrolling"
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <ScrollText size={20} />
            <span className="text-[12px] font-medium">{t("readerSettings.scrolling")}</span>
          </button>
          <button
            onClick={() => update({ readingMode: "paginated" })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.readingMode === "paginated"
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <BookOpen size={20} />
            <span className="text-[12px] font-medium">{t("readerSettings.pageTurning")}</span>
          </button>
        </div>
        {overrideNote("readingMode")}
      </div>)}

      {/* Page columns — only formats whose renderer supports a spread. */}
      {capabilities.supportsSpread && settings.readingMode === "paginated" && (<div className="px-4 py-3 border-b border-border-light">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase mb-2">{t("readerSettings.pageLayout")}</p>
        <div className="flex gap-2">
          <button
            onClick={() => update({ pageColumns: 1 })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.pageColumns === 1
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <File size={20} />
            <span className="text-[12px] font-medium">{t("readerSettings.singlePage")}</span>
          </button>
          <button
            onClick={() => update({ pageColumns: 2 })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.pageColumns === 2
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <Files size={20} />
            <span className="text-[12px] font-medium">{t("readerSettings.twoPages")}</span>
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-text-muted">
          {t("readerSettings.twoPagesHint")}
        </p>
        {overrideNote("pageColumns")}
      </div>)}

      {settings.readingMode === "paginated" && (
        <div className="border-b border-border-light px-4 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase text-text-muted">{t("readerSettings.pageTurnAnimation")}</p>
          <Select
            value={settings.pageTurnAnimation}
            onChange={(value) => update({ pageTurnAnimation: value as PageTurnAnimation })}
            options={[
              { value: "slide", label: t("readerSettings.animationSlide") },
              { value: "fade", label: t("readerSettings.animationFade") },
              { value: "cover", label: t("readerSettings.animationCover") },
              { value: "none", label: t("readerSettings.animationNone") },
            ]}
          />
        </div>
      )}

      <div className="border-b border-border-light px-4 py-3">
        <p className="mb-2 text-[11px] font-medium uppercase text-text-muted">{t("readerSettings.progressDisplay")}</p>
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] text-text-primary">{t("readerSettings.chapterProgressAlways")}</span>
            <Toggle
              label={t("readerSettings.chapterProgressAlways")}
              checked={settings.showChapterProgress}
              onChange={(checked) => update({ showChapterProgress: checked })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] text-text-primary">{t("readerSettings.bookProgress")}</span>
            <Toggle
              label={t("readerSettings.bookProgress")}
              checked={settings.showBookProgress}
              onChange={(checked) => update({ showBookProgress: checked })}
            />
          </div>
          {settings.readingMode === "paginated" && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-text-primary">{t("readerSettings.pageNumbers")}</span>
              <Toggle
                label={t("readerSettings.pageNumbers")}
                checked={settings.showPageNumbers}
                onChange={(checked) => update({ showPageNumbers: checked })}
              />
            </div>
          )}
        </div>
      </div>

      <div className="border-b border-border-light px-4 py-3">
        <p className="text-[11px] font-medium uppercase text-text-muted">{t("readerSettings.pageTurnBindings")}</p>
        <p className="mb-3 mt-1 text-[11px] leading-4 text-text-muted">{t("readerSettings.pageTurnBindingsHint")}</p>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-text-primary">{t("readerSettings.previousPage")}</span>
            <PageTurnBindingButton
              direction="previous"
              value={settings.previousPageBinding}
              active={capturingBinding === "previous"}
              onActivate={setCapturingBinding}
              onChange={(value) => update({
                previousPageBinding: value,
                ...(value === settings.nextPageBinding
                  ? { nextPageBinding: settings.previousPageBinding }
                  : {}),
              })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-text-primary">{t("readerSettings.nextPage")}</span>
            <PageTurnBindingButton
              direction="next"
              value={settings.nextPageBinding}
              active={capturingBinding === "next"}
              onActivate={setCapturingBinding}
              onChange={(value) => update({
                nextPageBinding: value,
                ...(value === settings.previousPageBinding
                  ? { previousPageBinding: settings.nextPageBinding }
                  : {}),
              })}
            />
          </div>
        </div>
      </div>

      {capabilities.supportsReflowSettings && (<div className="px-4 py-3 flex flex-col gap-4">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase">{t("readerSettings.layout")}</p>

        {/* Line Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.lineSpacing")}</span>
            <span className="text-[13px] text-text-muted">{settings.lineSpacing}</span>
          </div>
          <input
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={settings.lineSpacing}
            onChange={(e) => update({ lineSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
          {overrideNote("lineSpacing")}
        </div>

        {/* Character Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.charSpacing")}</span>
            <span className="text-[13px] text-text-muted">{settings.charSpacing}%</span>
          </div>
          <input
            type="range"
            min={-5}
            max={20}
            step={1}
            value={settings.charSpacing}
            onChange={(e) => update({ charSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
          {overrideNote("charSpacing")}
        </div>

        {/* Word Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.wordSpacing")}</span>
            <span className="text-[13px] text-text-muted">{settings.wordSpacing}%</span>
          </div>
          <input
            type="range"
            min={-10}
            max={50}
            step={1}
            value={settings.wordSpacing}
            onChange={(e) => update({ wordSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
          {overrideNote("wordSpacing")}
        </div>

        <div className="border-t border-border-light pt-4">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">{t("readerSettings.paragraph")}</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.justify")}</span>
              <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{t("readerSettings.justifyHint")}</p>
            </div>
            <Toggle label={t("readerSettings.justify")} checked={settings.textJustification} onChange={(checked) => update({ textJustification: checked })} />
          </div>
          {overrideNote("textJustification")}
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.paragraphSpacing")}</span>
              {settings.paragraphSpacing === "original" && <span className="text-[11px] text-text-muted">{t("readerSettings.publisherDefault")}</span>}
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-bg-input p-1" role="group" aria-label={t("readerSettings.paragraphSpacing")}>
              {(["none", "compact", "comfortable", "loose"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={settings.paragraphSpacing === value}
                  onClick={() => update({ paragraphSpacing: value })}
                  className={`h-7 rounded-md text-[11px] transition-colors ${settings.paragraphSpacing === value ? "bg-bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}
                >
                  {t(`readerSettings.paragraphSpacing.${value}`)}
                </button>
              ))}
            </div>
            {overrideNote("paragraphSpacing")}
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <div>
              <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.firstLineIndent")}</span>
              <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{t("readerSettings.firstLineIndentHint")}</p>
            </div>
            <Toggle label={t("readerSettings.firstLineIndent")} checked={settings.firstLineIndent} onChange={(checked) => update({ firstLineIndent: checked })} />
          </div>
          {overrideNote("firstLineIndent")}
        </div>

        {/* Margins */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">{t("readerSettings.margins")}</span>
            <span className="text-[13px] text-text-muted">{settings.margins}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={settings.margins}
            onChange={(e) => update({ margins: Number(e.target.value) })}
            className={sliderClass}
          />
          {overrideNote("margins")}
        </div>
      </div>)}

      {capabilities.supportsWordMarkers && (
        <div className="px-4 py-3 border-t border-border-light flex flex-col gap-3">
          <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase">{t("readerSettings.wordMarkers")}</p>
          {[
            ["showLookupMarkers", "readerSettings.lookupMarkers"],
            ["showNewVocabMarkers", "readerSettings.newVocabMarkers"],
            ["showLearningMarkers", "readerSettings.learningMarkers"],
            ["showMasteredMarkers", "readerSettings.masteredMarkers"],
          ].map(([key, label]) => (
            <div key={key}>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-text-primary">{t(label)}</span>
                <Toggle
                  label={t(label)}
                  checked={settings[key as keyof Pick<ReaderSettingsState, "showLookupMarkers" | "showNewVocabMarkers" | "showLearningMarkers" | "showMasteredMarkers">]}
                  onChange={(checked) => update({ [key]: checked } as Partial<ReaderSettingsState>)}
                />
              </div>
              {overrideNote(key as PerBookOverrideKey)}
            </div>
          ))}
        </div>
      )}

      {onClearLookupMarks && (
        <div className="px-4 py-3 border-t border-border-light">
          {clearLookupConfirm ? (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] leading-5 text-text-muted">
                {t("readerSettings.clearLookupMarksConfirm")}
              </p>
              {clearLookupError && (
                <p role="alert" className="text-[12px] text-danger-text">
                  {t("readerSettings.clearLookupMarksFailed")}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={clearLookupBusy}
                  className="h-8 px-2 rounded-md text-[12px] text-text-muted hover:bg-bg-input disabled:opacity-50"
                  onClick={() => {
                    setClearLookupConfirm(false);
                    setClearLookupError(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={clearLookupBusy}
                  className="h-8 px-2 rounded-md inline-flex items-center gap-1.5 text-[12px] text-danger-text hover:bg-danger-bg disabled:opacity-50"
                  onClick={async () => {
                    setClearLookupBusy(true);
                    setClearLookupError(false);
                    try {
                      await onClearLookupMarks();
                      setClearLookupConfirm(false);
                    } catch {
                      setClearLookupError(true);
                    } finally {
                      setClearLookupBusy(false);
                    }
                  }}
                >
                  {clearLookupBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {t("readerSettings.clearLookupMarksAction")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="h-8 -mx-2 px-2 rounded-md inline-flex items-center gap-2 text-[12px] text-danger-text hover:bg-danger-bg"
              onClick={() => setClearLookupConfirm(true)}
            >
              <Trash2 size={13} />
              {t("readerSettings.clearLookupMarks")}
            </button>
          )}
        </div>
      )}
      {undoValues && Object.keys(undoValues).length > 0 && (
        <div role="status" className="sticky bottom-2 mx-3 mt-2 flex items-center rounded-lg bg-text-primary px-3 py-2.5 text-[11px] text-bg-surface shadow-popover">
          <span className="min-w-0 flex-1 truncate">{undoLabel}</span>
          <button
            type="button"
            className="ml-2 shrink-0 font-medium text-accent-bg hover:underline"
            onClick={async () => {
              if (!onUndoRestoreBookOverrides) return;
              const values = undoValues;
              setScopeBusy(true);
              try {
                await onUndoRestoreBookOverrides(values);
                setUndoValues(null);
              } catch {
                setScopeError(true);
              } finally {
                setScopeBusy(false);
              }
            }}
          >
            {t("common.undo")}
          </button>
        </div>
      )}
    </div>
  );
}
