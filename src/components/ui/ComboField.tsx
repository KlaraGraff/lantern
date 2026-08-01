import { useCallback, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import Input from "./Input";
import OptionMenu, { type OptionMenuItem } from "./OptionMenu";

export interface ComboGroup {
  /** Heading shown above these options — this is where the values came from. */
  label: string;
  options: string[];
}

interface ComboFieldProps {
  /** Announced on the menu and refresh buttons, which are icon-only. */
  label: string;
  value: string;
  groups: ComboGroup[];
  onChange: (value: string) => void;
  /** Fires on blur and Enter, for fields that persist on commit rather than per keystroke. */
  onCommit?: (value: string) => void;
  /** Pinned first row, meaning "clear this field". Omitted when undefined. */
  emptyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
  refreshDisabled?: boolean;
}

/**
 * A text field whose known-good values live one click away, grouped by where
 * they came from.
 *
 * Typing is always available — the values these fields take (model ids, voice
 * names, reasoning levels) are ultimately whatever the provider accepts, and no
 * list we can assemble is authoritative. The menu is a shortcut, not the set of
 * legal answers, and its group headings say which source vouched for each row so
 * a level the endpoint reported can't be mistaken for one we ship.
 */
export default function ComboField({
  label,
  value,
  groups,
  onChange,
  onCommit,
  emptyLabel,
  placeholder,
  disabled,
  maxLength,
  className = "",
  onRefresh,
  refreshing,
  refreshLabel,
  refreshDisabled,
}: ComboFieldProps) {
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const items: OptionMenuItem[] = [
    ...(emptyLabel ? [{ value: "", label: emptyLabel }] : []),
    ...groups.flatMap((group) =>
      group.options.map((option) => ({ value: option, label: option, group: group.label })),
    ),
  ];
  const commit = () => onCommit?.(value);

  return (
    <div className={className}>
      <div ref={fieldRef} className="flex gap-2">
        <Input
          className="min-w-0 flex-1"
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <button
          type="button"
          disabled={disabled || items.length === 0}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:bg-bg-input hover:text-accent-text disabled:opacity-40"
        >
          <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {onRefresh && (
          <button
            type="button"
            disabled={disabled || refreshing || refreshDisabled}
            title={refreshLabel}
            aria-label={refreshLabel}
            onClick={onRefresh}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:bg-bg-input hover:text-accent-text disabled:opacity-40"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      {open && (
        <OptionMenu
          anchorRef={fieldRef}
          items={items}
          value={value}
          onSelect={(next) => {
            onChange(next);
            onCommit?.(next);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
