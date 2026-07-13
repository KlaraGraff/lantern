import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BookmarkPlus,
  Copy,
  Highlighter,
  Languages,
  MessageSquareMore,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { InteractionKind } from "./reader-interaction";

export type ReaderMenuAction = "primary" | "ask-ai" | "save" | "highlight" | "translate" | "copy";

interface ReaderContextMenuProps {
  x: number;
  y: number;
  text: string;
  kind: InteractionKind;
  marked?: boolean;
  hasBookWordMark?: boolean;
  markStateLoading?: boolean;
  showTranslate?: boolean;
  order?: ReaderMenuAction[];
  onClose: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onQuote: () => void;
  onLookup: () => void;
  onTranslate: () => void;
  onSave: () => void;
  onToggleMark?: () => void;
  onRemoveBookWordMark?: () => void;
}

export default function ReaderContextMenu({
  x,
  y,
  text,
  kind,
  marked = false,
  hasBookWordMark = false,
  markStateLoading = false,
  showTranslate = false,
  order = ["primary", "ask-ai", "save", "highlight", "copy"],
  onClose,
  onCopy,
  onExplain,
  onQuote,
  onLookup,
  onTranslate,
  onSave,
  onToggleMark,
  onRemoveBookWordMark,
}: ReaderContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = useMemo(() => {
    const values = [...order];
    if (showTranslate && !values.includes("translate")) values.splice(1, 0, "translate");
    return values.filter((action) => action !== "highlight" || onToggleMark);
  }, [onToggleMark, order, showTranslate]);

  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']");
    buttons?.[0]?.focus();
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const positionMenu = () => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      const top = y + rect.height <= window.innerHeight - 8
        ? y
        : Math.max(8, y - rect.height - 8);
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
  }, [x, y]);

  const primaryIsLookup = kind !== "passage";
  const definitions: Record<ReaderMenuAction, { label: string; icon: typeof Sparkles; run: () => void }> = {
    primary: {
      label: kind === "word"
        ? t("contextMenu.lookUp", { defaultValue: "查词" })
        : primaryIsLookup
          ? t("contextMenu.definePhrase", { defaultValue: "释义" })
          : t("contextMenu.interpretPassage", { defaultValue: "解读" }),
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
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={text}
      className="fixed z-50 w-[220px] rounded-md border border-border bg-bg-surface py-1 shadow-context"
      style={{ left: x, top: y }}
    >
      {actions.map((action) => {
        const definition = definitions[action];
        const Icon = definition.icon;
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
              {action === "copy" ? (
                <span className="text-[11px] text-text-muted">{navigator.platform.includes("Mac") ? "⌘C" : "Ctrl+C"}</span>
              ) : null}
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
