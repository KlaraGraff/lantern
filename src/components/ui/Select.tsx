import { useCallback, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import OptionMenu, { type OptionMenuItem } from "./OptionMenu";

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

  const selected = options.find((o) => o.value === value);

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

      {open && (
        <OptionMenu
          anchorRef={buttonRef}
          items={options}
          value={value}
          onSelect={onChange}
          onClose={close}
        />
      )}
    </div>
  );
}
