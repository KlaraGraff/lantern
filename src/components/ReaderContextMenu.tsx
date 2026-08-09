import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookmarkPlus,
  CircleHelp,
  Copy,
  Highlighter,
  Languages,
  MessageSquareMore,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  READER_CONTEXT_MENU_KEY_EVENT,
  readerMenuActivationIndex,
  readerMenuFocusIndex,
  type ReaderContextMenuKeyDetail,
  type InteractionKind,
  type SerializableRect,
} from "./reader-interaction";
import SpeakMenuRow from "./speech/SpeakMenuRow";
import { playbackDetaches } from "./speech/routing";
import {
  menuShortcut,
  readerMenuRows,
  reservedCopyShortcut,
  type ReaderActionBinding,
  type ReaderMenuAction,
} from "./reader-bindings";
import { useSettings } from "../hooks/useSettings";

export type { ReaderMenuAction };

interface DictionaryGroup {
  pos: string;
  senses: string;
}

interface DictionaryEntry {
  word: string;
  phonetic: string | null;
  groups: DictionaryGroup[];
  omittedSenseCount: number;
  fallbackSummary: string | null;
}

interface ReaderContextMenuProps {
  anchorRect: SerializableRect;
  text: string;
  kind: InteractionKind;
  marked?: boolean;
  hasBookWordMark?: boolean;
  markStateLoading?: boolean;
  showTranslate?: boolean;
  order?: ReaderMenuAction[];
  /** Read to print each row's shortcut. Empty means no row shows one. */
  bindings?: ReaderActionBinding[];
  /** Off hides every hint, including the ⌘C the copy row never had to earn. */
  showShortcuts?: boolean;
  onClose: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onQuote: () => void;
  onLookup: () => void;
  onNote?: () => void;
  onXray?: () => void;
  onTranslate: () => void;
  onSave: () => void;
  onToggleMark?: () => void;
  onRemoveBookWordMark?: () => void;
  customActions?: Array<{ id: `custom_${string}`; name: string }>;
  onCustomAction?: (id: `custom_${string}`) => void;
}

export default function ReaderContextMenu({
  anchorRect,
  text,
  kind,
  marked = false,
  hasBookWordMark = false,
  markStateLoading = false,
  showTranslate = false,
  order = ["primary", "ask-ai", "save", "highlight", "copy"],
  bindings = [],
  showShortcuts = true,
  onClose,
  onCopy,
  onExplain,
  onQuote,
  onLookup,
  onNote,
  onXray,
  onTranslate,
  onSave,
  onToggleMark,
  onRemoveBookWordMark,
  customActions = [],
  onCustomAction,
}: ReaderContextMenuProps) {
  const { t, i18n } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  // Every standalone component that needs a setting reads it this way — the
  // reader's own `useReaderSettingsSync` is out of reach from a component
  // this self-contained, and a generic key-value fetch here is cheap.
  const { settings: dictionarySettings } = useSettings();
  const dictionaryEnabled = dictionarySettings.dictionary_lookup_enabled !== "false";
  const [dictionaryEntry, setDictionaryEntry] = useState<DictionaryEntry | null>(null);
  // Single click already opens this menu after the double-click grace period
  // (`cancelPendingWordClick` in useReaderInteractions.ts) has passed, so no
  // new gesture is introduced — this is one more row on a toolbar that was
  // already going to appear.
  const dictionaryQuery = kind === "word" && dictionaryEnabled ? text : null;

  useEffect(() => {
    setDictionaryEntry(null);
    if (!dictionaryQuery) return;
    let cancelled = false;
    invoke<DictionaryEntry>("dictionary_lookup_word", { word: dictionaryQuery })
      .then((entry) => {
        if (!cancelled) setDictionaryEntry(entry);
      })
      .catch(() => {
        // A genuine not-found, or a failure with no usable fallback: the row
        // simply does not appear. No "not found" message is ever shown.
        if (!cancelled) setDictionaryEntry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dictionaryQuery]);

  const customActionIds = customActions.map((action) => action.id);
  const customActionKey = customActionIds.join(",");
  const actions = useMemo(
    () => readerMenuRows(order, {
      showTranslate,
      canToggleMark: Boolean(onToggleMark),
      customActionIds: customActionKey ? customActionKey.split(",") : [],
    }),
    [customActionKey, onToggleMark, order, showTranslate],
  );

  useEffect(() => {
    // Moving focus on mount hides WebKit's native reader selection.
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const handleMenuKey = (key: string, shiftKey = false, modified = false) => {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
      if (key === "Escape") {
        onClose();
        return true;
      }
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const activation = readerMenuActivationIndex(key, current, items.length, modified);
      if (activation !== null) {
        items[activation]?.click();
        return true;
      }
      const next = readerMenuFocusIndex(key, current, items.length, shiftKey, modified);
      if (next === null) return false;
      items[next]?.focus();
      return true;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!handleMenuKey(
        event.key,
        event.shiftKey,
        event.altKey || event.ctrlKey || event.metaKey,
      )) return;
      event.preventDefault();
    };
    const handleReaderKey = (event: Event) => {
      const detail = (event as CustomEvent<ReaderContextMenuKeyDetail>).detail;
      if (handleMenuKey(detail.key, detail.shiftKey, detail.modified)) detail.handled = true;
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(READER_CONTEXT_MENU_KEY_EVENT, handleReaderKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(READER_CONTEXT_MENU_KEY_EVENT, handleReaderKey);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const positionMenu = () => {
      const rect = element.getBoundingClientRect();
      const gap = 8;
      const roomRight = window.innerWidth - anchorRect.right - gap;
      const roomLeft = anchorRect.left - gap;
      const canPlaceBeside = roomRight >= rect.width || roomLeft >= rect.width;
      const left = roomRight >= rect.width
        ? anchorRect.right + gap
        : roomLeft >= rect.width
          ? anchorRect.left - rect.width - gap
          : Math.max(gap, Math.min(anchorRect.right - rect.width, window.innerWidth - rect.width - gap));
      const top = canPlaceBeside
        ? Math.max(gap, Math.min(anchorRect.top, window.innerHeight - rect.height - gap))
        : anchorRect.bottom + gap + rect.height <= window.innerHeight
          ? anchorRect.bottom + gap
          : Math.max(gap, anchorRect.top - rect.height - gap);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(element);
    window.addEventListener("resize", positionMenu);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionMenu);
    };
  }, [anchorRect]);

  const primaryIsLookup = kind !== "passage";
  const definitions: Record<string, { label: string; icon: typeof Sparkles; run: () => void }> = {
    primary: {
      // One label for all three kinds now: word/phrase/passage used to say
      // 查词/释义/解读, which read as three different actions. They were
      // always the same AI call (`onLookup`/`onExplain` differ only in
      // whether the reader has a selection) — 查词 itself now names the new,
      // free, single-click dictionary layer below instead.
      label: t("contextMenu.explain", { defaultValue: "解释" }),
      icon: Sparkles,
      run: primaryIsLookup ? onLookup : onExplain,
    },
    "ask-ai": {
      label: t("contextMenu.askAi", { defaultValue: "问 AI" }),
      icon: MessageSquareMore,
      run: onQuote,
    },
    save: {
      label: t("contextMenu.save", { defaultValue: "收藏" }),
      icon: BookmarkPlus,
      run: onSave,
    },
    highlight: {
      label: marked
        ? kind === "word"
          ? t("contextMenu.removeCurrentMark", { defaultValue: "取消当前标记" })
          : t("contextMenu.removeHighlight", { defaultValue: "取消标记" })
        : t("contextMenu.mark", { defaultValue: "标记" }),
      icon: Highlighter,
      run: onToggleMark ?? (() => {}),
    },
    translate: {
      label: t("contextMenu.translateOnly", { defaultValue: "仅翻译" }),
      icon: Languages,
      run: onTranslate,
    },
    copy: {
      label: t("contextMenu.copy"),
      icon: Copy,
      run: onCopy,
    },
    ...Object.fromEntries(customActions.map((action) => [action.id, {
      label: action.name,
      icon: Sparkles,
      run: () => onCustomAction?.(action.id),
    }])),
  };

  const showDictionary = kind === "word" && dictionaryEntry !== null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={text}
      className={`fixed z-[62] ${showDictionary ? "w-[300px]" : "w-[220px]"} rounded-md border border-border bg-bg-surface py-1 shadow-context`}
      style={{ left: anchorRect.right, top: anchorRect.bottom + 8 }}
    >
      {showDictionary && dictionaryEntry ? (
        <div className="mx-1 mb-1 border-b border-border-light px-2 pb-2 pt-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-text-primary">{dictionaryEntry.word}</span>
            {dictionaryEntry.phonetic ? (
              <span className="text-[11px] text-text-muted">/{dictionaryEntry.phonetic}/</span>
            ) : null}
          </div>
          {dictionaryEntry.fallbackSummary ? (
            // Degraded fallback: no phonetic, no part-of-speech grouping —
            // one line, already hard-truncated by the backend.
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-text-secondary">
              {dictionaryEntry.fallbackSummary}
            </p>
          ) : (
            <>
              <div className="mt-1 space-y-1">
                {dictionaryEntry.groups.map((group, index) => (
                  // `line-clamp-2` is the visual cap the spec actually states —
                  // two lines per part of speech, ellipsis, no scroll and no way
                  // to expand. The backend's character budget decides how many
                  // senses to send and therefore what `omittedSenseCount` says;
                  // it cannot know this menu's width, and a single unsplittable
                  // sense is deliberately never cut mid-way there, so without
                  // this a full-budget group renders three lines.
                  <p key={index} className="line-clamp-2 text-[12px] leading-5 text-text-secondary">
                    {group.pos ? (
                      <span className="mr-1 font-medium text-text-primary">{group.pos}</span>
                    ) : null}
                    {group.senses}
                  </p>
                ))}
              </div>
              {dictionaryEntry.omittedSenseCount > 0 ? (
                <p className="mt-1 text-[11px] leading-4 text-text-muted">
                  {t("dictionary.moreSenses", { count: dictionaryEntry.omittedSenseCount })}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {onNote ? (
        <button
          type="button"
          role="menuitem"
          onClick={onNote}
          className="mx-1 flex h-9 w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 text-left text-[13px] font-medium text-text-primary hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <MessageSquareMore size={16} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate">{t("readerNotes.menuAction")}</span>
        </button>
      ) : null}
      {onXray ? (
        <button
          type="button"
          role="menuitem"
          onClick={onXray}
          className="mx-1 flex h-9 w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 text-left text-[13px] font-medium text-text-primary hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CircleHelp size={16} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate">{t("readerXray.menuAction")}</span>
        </button>
      ) : null}
      {actions.map((action) => {
        const shortcut = showShortcuts ? menuShortcut(bindings, action, kind, i18n.language) : null;
        // Owns its own playback and accent toggle, so it needs no wiring from
        // the reader and does not dismiss the menu when used.
        if (action === "speak") {
          return (
            <SpeakMenuRow
              key={action}
              text={text}
              kind={kind}
              shortcut={shortcut}
              // Same rule the player uses to decide whether this row may still
              // cancel the audio, so the menu never closes on a playback that
              // dies with it.
              onHandOff={playbackDetaches(kind) ? onClose : undefined}
            />
          );
        }
        const definition = definitions[action];
        if (!definition) return null;
        const Icon = definition.icon;
        // A binding wins over ⌘C. Both really do copy, but the one the reader
        // chose is the more useful of the two to print — and ⌘C is reserved, so
        // it can never turn out to belong to some other row.
        const hint = shortcut
          ?? (showShortcuts && action === "copy" ? reservedCopyShortcut(i18n.language) : null);
        const showRemoveBookWordMark = action === "highlight"
          && kind === "word"
          && marked
          && hasBookWordMark
          && onRemoveBookWordMark;
        return (
          <div key={action}>
            <button
              type="button"
              role="menuitem"
              onClick={definition.run}
              disabled={action === "highlight" && markStateLoading}
              aria-busy={action === "highlight" && markStateLoading ? true : undefined}
              className="mx-1 flex h-9 w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 text-left text-[13px] font-medium text-text-primary hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50"
            >
              <Icon size={16} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{definition.label}</span>
              {hint ? <span className="shrink-0 text-[11px] text-text-muted">{hint}</span> : null}
            </button>
            {showRemoveBookWordMark && (
              <button
                type="button"
                role="menuitem"
                onClick={onRemoveBookWordMark}
                className="mx-1 flex h-9 w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 text-left text-[13px] font-medium text-text-primary hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Highlighter size={16} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {t("contextMenu.removeBookWordMark", { defaultValue: "取消全书同词标记" })}
                </span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
