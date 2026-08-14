import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookmarkPlus,
  Check,
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
import DictionaryCard, { type DictionaryEntry } from "./DictionaryCard";
import { anchorTransformOrigin } from "./motion";
import { readSafeInsetBottom, readSafeInsetTop } from "../utils/safe-inset";
import {
  clickSpendsGlance,
  glanceCounts,
  glanceDefinition,
  newGlanceAttempt,
  GLANCE_DWELL_MS,
  GLANCE_SAFE_ATTR,
  type GlanceClickNode,
} from "./dictionary-glance";
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
import { useIsNarrow } from "../hooks/useIsNarrow";

export type { ReaderMenuAction };

/**
 * One menu row. 36px under a mouse, 44px under a finger — the same floor every
 * other touch surface in the app uses, and the reason this menu needed the
 * `touch:` variant at all: a long press now opens it (see `long-press.ts`), so
 * it is a control a thumb has to hit rather than one a cursor points at.
 */
const MENU_ROW_CLASS = "mx-1 flex h-9 touch:h-11 w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 text-left text-[13px] touch:text-[15px] font-medium text-text-primary hover:bg-accent-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface ReaderContextMenuProps {
  anchorRect: SerializableRect;
  text: string;
  kind: InteractionKind;
  marked?: boolean;
  /**
   * The word is already in the vocabulary list, so the save row says so and
   * stops offering the action. Only the callers that know the answer before the
   * menu opens pass it — the reader's own menu does not ask.
   */
  saved?: boolean;
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
  /**
   * The reader read the dictionary entry and did nothing else — see
   * `dictionary-glance.ts` for the three conditions. Fired once per word, at
   * the moment the menu closes on it (or the reader clicks a second word).
   * Omitted by the reader for menus a glance cannot come from, e.g. a word
   * reached by dragging a selection rather than by a single click.
   */
  onGlance?: (definition: string) => void;
  customActions?: Array<{ id: `custom_${string}`; name: string }>;
  onCustomAction?: (id: `custom_${string}`) => void;
}

export default function ReaderContextMenu({
  anchorRect,
  text,
  kind,
  marked = false,
  saved = false,
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
  onGlance,
  customActions = [],
  onCustomAction,
}: ReaderContextMenuProps) {
  const { t, i18n } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  // Every standalone component that needs a setting reads it this way — the
  // reader's own `useReaderSettingsSync` is out of reach from a component
  // this self-contained, and a generic key-value fetch here is cheap.
  const { settings: dictionarySettings } = useSettings();
  const isNarrow = useIsNarrow();
  const dictionaryEnabled = dictionarySettings.dictionary_lookup_enabled !== "false";
  // The card's closing line tells the reader to double-click. It may only say
  // so while double-click actually looks the word up — the same key
  // `TextBookReader` and `useReaderInteractions` gate the gesture on. Below the
  // breakpoint that setting is beside the point: there is no double-click to
  // switch off, and the line points at this menu's own 「Explain in context」
  // row instead, which is there whatever the setting says.
  const doubleClickLooksUp =
    isNarrow || dictionarySettings.double_click_quick_lookup !== "false";
  const [dictionaryEntry, setDictionaryEntry] = useState<DictionaryEntry | null>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(false);
  // Single click already opens this menu after the double-click grace period
  // (`cancelPendingWordClick` in useReaderInteractions.ts) has passed, so no
  // new gesture is introduced — this is one more row on a toolbar that was
  // already going to appear.
  const dictionaryQuery = kind === "word" && dictionaryEnabled ? text : null;

  useEffect(() => {
    setDictionaryEntry(null);
    setDictionaryLoading(Boolean(dictionaryQuery));
    if (!dictionaryQuery) return;
    let cancelled = false;
    invoke<DictionaryEntry>("dictionary_lookup_word", { word: dictionaryQuery })
      .then((entry) => {
        if (!cancelled) setDictionaryEntry(entry);
      })
      .catch(() => {
        // A genuine not-found, or a failure with no usable fallback. The card
        // stays and says so: collapsing it here would move the whole menu a
        // second time, which is the jump the skeleton exists to avoid.
        if (!cancelled) setDictionaryEntry(null);
      })
      .finally(() => {
        if (!cancelled) setDictionaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dictionaryQuery]);

  // The running account for the word currently on the card. Mutated by the
  // three effects below rather than held in state: nothing here is rendered,
  // and a re-render per timer tick would re-measure and re-position the menu.
  const glanceRef = useRef(newGlanceAttempt());
  const onGlanceRef = useRef(onGlance);
  useEffect(() => {
    onGlanceRef.current = onGlance;
  });

  // Settlement. Runs when the menu unmounts and when the reader clicks a
  // second word without closing the first — both are "the menu closed on this
  // word" as far as the account is concerned. Declared before the two effects
  // that write to the account so that on a word change React resets it here
  // before either of them touches the new one.
  useEffect(() => {
    if (!dictionaryQuery) return;
    const attempt = (glanceRef.current = newGlanceAttempt());
    return () => {
      if (glanceCounts(attempt)) onGlanceRef.current?.(attempt.definition);
    };
  }, [dictionaryQuery]);

  // The dwell clock. Starts only once a real entry is on screen — the skeleton
  // is not a definition, and neither is 词典里没有这个词.
  useEffect(() => {
    if (dictionaryLoading || !dictionaryEntry) return;
    const attempt = glanceRef.current;
    attempt.definition = glanceDefinition(dictionaryEntry);
    const timer = window.setTimeout(() => {
      attempt.dwelt = true;
    }, GLANCE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [dictionaryEntry, dictionaryLoading]);

  // Did the reader go on to do something else? Listened for in the capture
  // phase, because the row's own handler closes the menu and the account has
  // to be marked before it does. Keyboard activation arrives here too — the
  // menu's shortcut handling clicks the row rather than calling it.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || !dictionaryQuery) return;
    const noteAction = (event: MouseEvent) => {
      const path: GlanceClickNode[] = [];
      for (let node = event.target as Element | null; node && node !== menu; node = node.parentElement) {
        path.push({
          isMenuItem: node.getAttribute("role") === "menuitem",
          glanceSafe: node.hasAttribute(GLANCE_SAFE_ATTR),
        });
      }
      if (clickSpendsGlance(path)) glanceRef.current.spent = true;
    };
    menu.addEventListener("click", noteAction, true);
    return () => menu.removeEventListener("click", noteAction, true);
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
    const handleClickOutside = (event: PointerEvent) => {
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
    document.addEventListener("pointerdown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(READER_CONTEXT_MENU_KEY_EVENT, handleReaderKey);
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(READER_CONTEXT_MENU_KEY_EVENT, handleReaderKey);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const positionMenu = () => {
      // Layout size, not `getBoundingClientRect()`: the menu wears an entry
      // animation that scales it from 96%, and a rect read mid-animation
      // would place the menu against a box 4% smaller than the one that
      // settles a frame later.
      const rect = { width: element.offsetWidth, height: element.offsetHeight };
      const gap = 8;
      // The floor is the home indicator's, not the screen's. A card clamped to
      // 8px off the bottom edge of a phone puts its last row — 复制 on a word,
      // and the row a reader is most likely to want after reading the card —
      // under the indicator, where the system claims the touch. Every other
      // bottom-anchored surface in the app already pays this inset in CSS; the
      // positioner has to pay it in numbers because it writes `top` itself.
      const floor = window.innerHeight - readSafeInsetBottom();
      // And the ceiling is the status bar's, for the same reason one line up.
      // A word near the top of the page pushes a tall card — a full dictionary
      // entry runs half the screen — past the anchor and onto the ceiling,
      // where 8px off the top of a phone puts the headword and its
      // pronunciation behind the clock and the camera housing. Measured on the
      // Simulator: 「Badger /ˈbædʒər/」 sat under the dynamic island, unreadable.
      const ceiling = readSafeInsetTop() + gap;
      const roomRight = window.innerWidth - anchorRect.right - gap;
      const roomLeft = anchorRect.left - gap;
      const canPlaceBeside = roomRight >= rect.width || roomLeft >= rect.width;
      const left = roomRight >= rect.width
        ? anchorRect.right + gap
        : roomLeft >= rect.width
          ? anchorRect.left - rect.width - gap
          : Math.max(gap, Math.min(anchorRect.right - rect.width, window.innerWidth - rect.width - gap));
      const top = canPlaceBeside
        ? Math.max(ceiling, Math.min(anchorRect.top, floor - rect.height - gap))
        : anchorRect.bottom + gap + rect.height <= floor
          ? anchorRect.bottom + gap
          : Math.max(ceiling, anchorRect.top - rect.height - gap);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      // Grow out of the selection, wherever the menu ended up relative to it.
      anchorTransformOrigin(
        element,
        { x: (anchorRect.left + anchorRect.right) / 2, y: (anchorRect.top + anchorRect.bottom) / 2 },
        { left, top },
      );
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
      label: saved
        ? t("contextMenu.saved", { defaultValue: "已收藏" })
        : t("contextMenu.save", { defaultValue: "收藏" }),
      icon: saved ? Check : BookmarkPlus,
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

  // Driven by the query, not by its result: the card is up before the lookup
  // resolves, so the menu never changes width or position mid-flight.
  const showDictionary = dictionaryQuery !== null;
  // The card carries its own pronounce button beside the word, so the row
  // below would be a duplicate.
  const speakInCard = showDictionary && actions.includes("speak");

  // The width cap below is a `max-w`, not a narrower fixed width under
  // `touch:`: 300px already fits a 390px phone, and only the smallest viewports
  // have to give any of it back. The positioner measures `offsetWidth`, so a
  // menu the cap has shrunk is still placed against its real box.
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={text}
      className={`motion-pop fixed z-[62] max-w-[calc(100vw-16px)] ${showDictionary ? "w-[300px]" : "w-[220px]"} rounded-md border border-border bg-bg-surface py-1 shadow-context`}
      style={{ left: anchorRect.right, top: anchorRect.bottom + 8 }}
    >
      {showDictionary ? (
        <DictionaryCard
          word={text}
          loading={dictionaryLoading}
          entry={dictionaryEntry}
          showSpeak={speakInCard}
          showAiHint={doubleClickLooksUp}
        />
      ) : null}
      {onNote ? (
        <button
          type="button"
          role="menuitem"
          onClick={onNote}
          className={MENU_ROW_CLASS}
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
          className={MENU_ROW_CLASS}
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
          if (speakInCard) return null;
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
              disabled={(action === "highlight" && markStateLoading) || (action === "save" && saved)}
              aria-busy={action === "highlight" && markStateLoading ? true : undefined}
              className={`${MENU_ROW_CLASS} disabled:opacity-50 ${
                action === "save" && saved ? "disabled:cursor-default" : "disabled:cursor-wait"
              }`}
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
                className={MENU_ROW_CLASS}
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
