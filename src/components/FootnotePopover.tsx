import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { prefersReducedMotion } from "./page-turn-transition";
import { usePopoverPosition } from "./use-popover-position";

// Total bubble width and the width handed to the nested foliate-view's
// content (useFoliateView sets the nested view's own `style.width` to this
// before it renders, so the extracted footnote text wraps at the size it
// will actually display at — no post-mount reflow). Kept a little narrower
// than the bubble's padded content box as a safety margin against the
// hairline border, so the nested view never forces a horizontal scrollbar.
export const FOOTNOTE_POPOVER_WIDTH = 340;
export const FOOTNOTE_CONTENT_WIDTH = 300;
export const FOOTNOTE_POPOVER_MIN_HEIGHT = 48;
export const FOOTNOTE_POPOVER_MAX_HEIGHT = 320;

export interface FootnotePopoverData {
  x: number;
  y: number;
  /** Visible text of the clicked reference marker (e.g. "1", "*"). */
  marker: string;
  href: string;
  /** The nested `<foliate-view>` rendered by foliate's FootnoteHandler, already laid out. */
  contentHost: HTMLElement;
  contentHeight: number;
}

interface FootnotePopoverProps extends FootnotePopoverData {
  onClose: () => void;
  onJumpToSource: () => void;
}

export default function FootnotePopover({
  x,
  y,
  marker,
  contentHost,
  contentHeight,
  onClose,
  onJumpToSource,
}: FootnotePopoverProps) {
  const { t } = useTranslation();
  const { ref: floatingRef, style: floatingStyle, isOutside } = usePopoverPosition(x, y);
  const bodyHostRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const reducedMotion = prefersReducedMotion();

  // The nested view arrives already open and laid out (see useFoliateView) —
  // this just reparents it into the visible bubble. On unmount it is only
  // detached, never `.close()`d: it shares the main reader's book instance,
  // and closing it would tear that down too.
  useEffect(() => {
    const host = bodyHostRef.current;
    if (!host) return;
    host.appendChild(contentHost);
    return () => {
      contentHost.remove();
    };
  }, [contentHost]);

  useEffect(() => {
    if (reducedMotion) return;
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [reducedMotion]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Dismiss on click outside — delay registration to avoid catching the
  // click that opened us.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isOutside(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, isOutside]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={floatingRef}
        className={`fixed z-50 rounded-lg border border-border/80 bg-bg-surface shadow-context ${
          reducedMotion
            ? ""
            : `transition-[opacity,transform] duration-150 ease-out ${
              entered ? "opacity-100 scale-100" : "opacity-0 scale-95"
            }`
        }`}
        style={{ ...floatingStyle, width: FOOTNOTE_POPOVER_WIDTH }}
      >
        <div className="px-3.5 pt-3">
          <span className="text-[12px] font-medium text-text-muted">
            {marker ? t("reader.footnote.label", { marker }) : t("reader.footnote.labelGeneric")}
          </span>
        </div>
        <div
          ref={bodyHostRef}
          className="px-3.5 pt-1.5 pb-3 overflow-auto"
          style={{ height: contentHeight }}
        />
        <div className="border-t border-border/40 px-3.5 py-2">
          <button
            onClick={onJumpToSource}
            className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
          >
            <ArrowRight size={14} />
            {t("reader.footnote.jumpToSource")}
          </button>
        </div>
      </div>
    </>
  );
}
