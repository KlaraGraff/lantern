import { Check } from "lucide-react";

interface ColorSwatchesProps {
  color: string;
  presets: readonly string[];
  onSelect: (color: string) => void;
  className?: string;
}

/**
 * The quick picks. Split out of `ColorControl` so a panel can put the swatches
 * where they are worth glancing at — next to a preview — and leave the hex
 * field and the opacity slider further down where they are only reached on
 * purpose.
 *
 * Five swatches at 44px with an 8px gap comes to 252px, so a finger-sized row
 * still fits a 390px phone on one line. The wrap is for the panel getting
 * narrower than that, not for touch.
 */
export default function ColorSwatches({ color, presets, onSelect, className = "" }: ColorSwatchesProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {presets.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-label={preset}
          aria-pressed={color === preset}
          title={preset}
          onClick={() => onSelect(preset)}
          className={`flex size-7 touch:size-11 items-center justify-center rounded-full border border-black/10 ${color === preset ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""}`}
          style={{ backgroundColor: preset }}
        >
          {color === preset && <Check size={13} className="text-white drop-shadow" />}
        </button>
      ))}
    </div>
  );
}
