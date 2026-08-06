import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import OptionMenu, { type OptionMenuItem } from "./OptionMenu";
import BottomSheet from "./BottomSheet";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";

interface SelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: OptionMenuItem[];
  className?: string;
  placeholder?: string;
}

export default function Select({ label, value, onChange, options, className = "", placeholder = "" }: SelectProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Presentation follows the input device, not the window width — a mouse-driven
  // window narrowed to phone width keeps the dropdown, and a large iPad under a
  // finger gets the sheet. See docs/impls/mobile-settings-mockup.html "sheet".
  const isTouch = useCoarsePointer();

  const selected = options.find((o) => o.value === value);
  const select = useCallback(
    (next: string) => {
      onChange(next);
      close();
    },
    [onChange, close],
  );

  return (
    <div className={`relative ${className}`}>
      {label && (
        <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
          {label}
        </label>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-9 bg-bg-input rounded-lg px-3 text-[13px] font-medium text-text-primary flex items-center justify-between cursor-pointer border border-transparent hover:border-border transition-colors"
      >
        <span className="min-w-0 truncate text-left">{selected?.label ?? placeholder}</span>
        <ChevronDown size={16} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {isTouch ? (
        <BottomSheet open={open} onClose={close} title={label || placeholder || undefined}>
          {options.map((item, index) => {
            const isActive = item.value === value;
            const showGroup = item.group && item.group !== options[index - 1]?.group;
            return (
              <div key={`${item.group ?? ""}:${item.value}`}>
                {showGroup && (
                  <div className="px-[18px] pb-1 pt-3 text-[11px] font-medium text-text-muted">{item.group}</div>
                )}
                <button
                  type="button"
                  onClick={() => select(item.value)}
                  className={`flex min-h-14 w-full items-center gap-3 border-t border-border-light px-[18px] py-2.5 text-left text-[15.5px] ${
                    isActive ? "text-accent-text font-semibold" : "text-text-primary"
                  }`}
                >
                  <Check size={18} className={`shrink-0 ${isActive ? "text-accent-text" : "opacity-0"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block">{item.label}</span>
                    {item.description && (
                      <span className="mt-0.5 block text-[12px] font-normal leading-[1.45] text-text-muted">
                        {item.description}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </BottomSheet>
      ) : (
        open && (
          <OptionMenu
            anchorRef={buttonRef}
            items={options}
            value={value}
            onSelect={onChange}
            onClose={close}
          />
        )
      )}
    </div>
  );
}
