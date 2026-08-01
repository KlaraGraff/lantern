import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

export interface OptionMenuItem {
  value: string;
  label: string;
  /** Rendered as a heading above the first item carrying it. */
  group?: string;
}

interface OptionMenuProps {
  /** Element the menu is measured and positioned against. */
  anchorRef: RefObject<HTMLElement | null>;
  items: OptionMenuItem[];
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}

const MENU_GAP = 4;
const OPTION_HEIGHT = 40;
const GROUP_HEIGHT = 24;
const VIEWPORT_MARGIN = 8;
const PORTALED_THEME_VARS = [
  "--color-bg-page",
  "--color-bg-surface",
  "--color-bg-muted",
  "--color-bg-input",
  "--color-text-primary",
  "--color-text-body",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-text-placeholder",
  "--color-border",
  "--color-border-light",
  "--color-accent",
  "--color-accent-text",
  "--color-accent-bg",
] as const;

function inheritedThemeVars(element: Element): CSSProperties {
  const computed = getComputedStyle(element);
  return PORTALED_THEME_VARS.reduce<CSSProperties>((style, name) => {
    const value = computed.getPropertyValue(name).trim();
    if (value) Object.assign(style, { [name]: value });
    return style;
  }, {});
}

/**
 * The dropdown half of `Select` and `ComboField`, portaled to `<body>` so it
 * can't be clipped by an overflow container (settings modal scroll area,
 * accordion animations) and positioned by hand for the same reason.
 */
export default function OptionMenu({ anchorRef, items, value, onSelect, onClose }: OptionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const groupCount = new Set(items.map((item) => item.group).filter(Boolean)).size;

  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    },
    [anchorRef, onClose],
  );

  useEffect(() => {
    const handleScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [handleClickOutside, onClose]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuHeight = items.length * OPTION_HEIGHT + groupCount * GROUP_HEIGHT + 2;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const openUp = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    setMenuStyle({
      ...inheritedThemeVars(anchor),
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(menuHeight, openUp ? spaceAbove : spaceBelow),
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  }, [anchorRef, groupCount, items.length]);

  if (!menuStyle) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={menuStyle}
      // The menu lives under document.body, so without this, pressing an option
      // registers as an outside click for ancestor popovers (e.g.
      // ReaderSettings) and closes them before the option's onClick fires.
      onMouseDown={(event) => event.stopPropagation()}
      className="fixed z-[70] bg-bg-surface border border-border rounded-xl shadow-popover overflow-y-auto"
    >
      {items.map((item, index) => {
        const isActive = item.value === value;
        const showGroup = item.group && item.group !== items[index - 1]?.group;
        return (
          <div key={`${item.group ?? ""}:${item.value}`}>
            {showGroup && (
              <div className="flex h-6 items-end px-4 pb-1 text-[10px] font-medium text-text-muted">
                {item.group}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                onSelect(item.value);
                onClose();
              }}
              className={`flex h-10 w-full cursor-pointer items-center justify-between gap-3 px-4 text-[14px] transition-colors ${
                isActive ? "bg-accent-bg text-accent-text" : "text-text-primary hover:bg-bg-input"
              }`}
            >
              <span className="min-w-0 truncate text-left">{item.label}</span>
              {isActive && <Check size={16} className="shrink-0 text-accent-text" />}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
