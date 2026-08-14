import type { ReactNode } from "react";

interface SliderProps {
  min: number;
  max: number;
  /**
   * Defaults to the HTML default of 1, which silently reduces a fractional
   * range to its two endpoints — always set it for non-integer sliders.
   */
  step?: number;
  value: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  label: string;
  displayValue: string;
  hint?: string;
  /**
   * Sits between the label row and the track — for preset shortcuts that belong
   * to this slider. They have to render inside it, not before it: a full-width
   * row of chips placed above the label reads, on a phone, as the tail of
   * whatever section the divider above it closed.
   */
  children?: ReactNode;
}

export default function Slider({
  min,
  max,
  step,
  value,
  onChange,
  onChangeEnd,
  label,
  displayValue,
  hint,
  children,
}: SliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-[14px] font-semibold text-text-primary">{label}</label>
        <span className="text-[14px] text-text-secondary">{displayValue}</span>
      </div>
      {children}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => onChangeEnd?.(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onChangeEnd?.(Number((e.target as HTMLInputElement).value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-dark bg-border"
      />
      {hint && (
        <p className="text-[12px] text-text-muted mt-1.5">{hint}</p>
      )}
    </div>
  );
}
