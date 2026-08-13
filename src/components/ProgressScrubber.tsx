import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  chapterAtFraction,
  fractionFromPointerX,
  type ScrubberTick,
} from "../pages/reader/progress-scrubber-math";

interface ProgressScrubberProps {
  /** Whole-book progress, 0-100 — used whenever the pointer isn't actively dragging. */
  progress: number;
  ticks: ScrubberTick[];
  isStandaloneWindow: boolean;
  /** Fires once, on release (pointer up) or on a discrete keyboard step — never while dragging. */
  onCommit: (fraction: number) => void;
}

const KEYBOARD_STEP = 0.01;
const KEYBOARD_PAGE_STEP = 0.1;

/**
 * Interactive scrubber (P1.6) replacing the old static 1px progress line for
 * paginated EPUBs. Thickens on hover/focus/drag (always-on under `touch:`,
 * since a finger has no hover state), shows chapter tick marks derived from
 * TOC data, and a tooltip with the chapter name + percentage under the
 * cursor (pushed further above the track under `touch:` so a finger doesn't
 * cover it). Dragging only moves a local indicator — navigation happens
 * once, in `onCommit`, on pointer release (or immediately for a discrete
 * keyboard step, since there is nothing to preview there). The hit area
 * grows under `touch:` via transparent padding on the outer element, not by
 * thickening the visible track — see `touch:py-5` below.
 */
export default function ProgressScrubber({
  progress,
  ticks,
  isStandaloneWindow,
  onCommit,
}: ProgressScrubberProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const currentFraction = dragFraction ?? progress / 100;
  const previewFraction = dragFraction ?? hoverFraction;
  const previewChapter = useMemo(
    () => (previewFraction === null ? undefined : chapterAtFraction(ticks, previewFraction)),
    [ticks, previewFraction],
  );

  const fractionFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return currentFraction;
    return fractionFromPointerX(event.clientX, rect);
  }, [currentFraction]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture can be rejected (seen on WKWebView); touch already has
      // implicit capture from pointerdown, so the drag must proceed either way.
    }
    setIsDragging(true);
    setDragFraction(fractionFromEvent(event));
  }, [fractionFromEvent]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setDragFraction(fractionFromEvent(event));
    } else {
      setHoverFraction(fractionFromEvent(event));
    }
  }, [fractionFromEvent, isDragging]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const fraction = fractionFromEvent(event);
    setIsDragging(false);
    setDragFraction(null);
    onCommit(fraction);
  }, [fractionFromEvent, isDragging, onCommit]);

  const handlePointerCancel = useCallback(() => {
    setIsDragging(false);
    setDragFraction(null);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!isDragging) setHoverFraction(null);
  }, [isDragging]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = currentFraction - KEYBOARD_STEP;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = currentFraction + KEYBOARD_STEP;
        break;
      case "PageDown":
        next = currentFraction - KEYBOARD_PAGE_STEP;
        break;
      case "PageUp":
        next = currentFraction + KEYBOARD_PAGE_STEP;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onCommit(Math.min(1, Math.max(0, next)));
  }, [currentFraction, onCommit]);

  const roundedPercent = Math.round(currentFraction * 100);
  const tooltipPercent = Math.round((previewFraction ?? currentFraction) * 100);
  const showTooltip = previewFraction !== null;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={t("reader.scrubber.label")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={roundedPercent}
      aria-valuetext={`${roundedPercent}%`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      className={`group relative w-full cursor-pointer touch-none py-1.5 touch:py-5 ${
        isDragging ? "" : ""
      }`}
    >
      <div
        className={`relative w-full rounded-full transition-[height] duration-150 motion-reduce:transition-none ${
          isDragging ? "h-1.5" : "h-px touch:h-1.5 group-hover:h-1.5 group-focus-visible:h-1.5"
        } ${isStandaloneWindow ? "opacity-10" : "bg-border"}`}
        style={isStandaloneWindow ? { backgroundColor: "currentColor" } : undefined}
      >
        <div
          className="absolute inset-y-0 left-0 h-full rounded-full"
          style={{
            width: `${clampPercent(currentFraction * 100)}%`,
            backgroundColor: isStandaloneWindow ? "currentColor" : "var(--color-text-muted)",
            opacity: isStandaloneWindow ? 0.4 : undefined,
          }}
        />
        {ticks.map((tick, index) => (
          <div
            key={index}
            aria-hidden="true"
            className={`absolute top-1/2 h-1 w-px -translate-y-1/2 ${isStandaloneWindow ? "opacity-40" : "bg-text-muted/50"}`}
            style={{
              left: `${clampPercent(tick.fraction * 100)}%`,
              backgroundColor: isStandaloneWindow ? "currentColor" : undefined,
            }}
          />
        ))}
        <div
          aria-hidden="true"
          className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity duration-150 motion-reduce:transition-none touch:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100 ${
            isDragging ? "opacity-100" : ""
          }`}
          style={{
            left: `${clampPercent(currentFraction * 100)}%`,
            backgroundColor: isStandaloneWindow ? "currentColor" : "var(--color-text-muted)",
          }}
        />
      </div>
      {showTooltip && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-2 touch:mb-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#18181B]/90 px-2.5 py-1.5 text-center text-[12px] leading-4 text-white shadow-popover"
          style={{ left: `${clampPercent((previewFraction ?? 0) * 100)}%` }}
        >
          {previewChapter
            ? t("reader.scrubber.tooltip", { chapter: previewChapter.label, progress: tooltipPercent })
            : `${tooltipPercent}%`}
        </div>
      )}
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
