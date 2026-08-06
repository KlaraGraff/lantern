import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading above the option list. Omitted entirely when the caller has no good title text — see `Select`. */
  title?: string;
  /** Second, muted line under the title. */
  description?: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * The touch presentation for pickers that are a dropdown (`OptionMenu`) under
 * a mouse — see `Select`. Scrim + sheet, portaled to `document.body` the same
 * way every other dialog in the app is (`ConfirmDialog`, `DensityHelpDialog`):
 * there is no shared portal-root component to route through, just
 * `createPortal(..., document.body)` called at the point of use.
 */
export default function BottomSheet({ open, onClose, title, description, children }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Capture the trigger on open and hand focus back to it on close, the same
  // shape as ReaderExportDialog's openerRef — a cleanup function fires on both
  // unmount and on the next run of this effect, which for a boolean dependency
  // means exactly "when `open` goes back to false".
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    return () => openerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Capture phase, ahead of any ancestor popover/dialog listening on
    // `document` — same reasoning as OptionMenu: the sheet is a layer of its
    // own, and Escape should dismiss it and go no further.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        // Stops a tap inside the sheet from reading as an outside click to an
        // ancestor popover it happens to be portaled past (e.g. ReaderSettings) —
        // the same defensive stopPropagation OptionMenu uses for the same reason.
        onMouseDown={(event) => event.stopPropagation()}
        className="absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-[20px] bg-bg-surface pt-2 shadow-context"
      >
        <div className="mx-auto h-1 w-[38px] shrink-0 rounded-full bg-border" aria-hidden="true" />
        {title && (
          <h2 id={titleId} className="shrink-0 px-[18px] pb-1 pt-2 text-[16px] font-semibold tracking-[-0.2px] text-text-primary">
            {title}
          </h2>
        )}
        {description && (
          <p id={descriptionId} className="shrink-0 px-[18px] pb-2.5 text-[12.5px] leading-[1.6] text-text-muted">
            {description}
          </p>
        )}
        <div className="min-h-0 overflow-y-auto overscroll-contain pb-[calc(var(--spacing-safe-bottom)+8px)]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
