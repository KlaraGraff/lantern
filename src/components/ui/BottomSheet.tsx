import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusFirstElement, trapTabKey } from "../focus-trap";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading above the option list. Omitted entirely when the caller has no good title text — see `Select`. */
  title?: string;
  /** Second, muted line under the title. */
  description?: string;
  /**
   * Off for a caller that already traps focus on its own root — the learning
   * card does, on the wrapper it puts `tabIndex={-1}` on. Two traps over one
   * dialog is not twice as safe: this one listens on `document` in the capture
   * phase, so it would eat the Escape the caller's own listener is waiting for,
   * and Tab would be answered by whichever trap ran first.
   */
  manageFocus?: boolean;
  /**
   * Off when the children own their scrolling. The default single scroll
   * region is right for a list of options; a card with its own sticky header
   * and internal panes needs the height handed to it instead.
   */
  scroll?: boolean;
  children: ReactNode;
}

/**
 * A sheet that rises from the bottom edge: the touch presentation for pickers
 * that are a dropdown (`OptionMenu`) under a mouse — see `Select` — and for
 * anything else that is a floating box on a desktop and has nowhere to float
 * on a phone. Scrim + sheet, portaled to `document.body` the same way every
 * other dialog in the app is (`ConfirmDialog`, `DensityHelpDialog`): there is
 * no shared portal-root component to route through, just
 * `createPortal(..., document.body)` called at the point of use.
 *
 * Everything a sheet looks like — the scrim, the corner radius, the grabber,
 * the height ceiling, the layer it sits on — lives here and only here. The two
 * behaviours callers genuinely differ on, focus and scrolling, are props
 * rather than a second copy of this file: sheets that disagree about their own
 * geometry are sheets a reader can tell apart, which is the one thing they
 * must never be.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  description,
  manageFocus = true,
  scroll = true,
  children,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Capture the trigger on open and hand focus back to it on close, the same
  // shape as ReaderExportDialog's openerRef — a cleanup function fires on both
  // unmount and on the next run of this effect, which for a boolean dependency
  // means exactly "when `open` goes back to false".
  useEffect(() => {
    if (!open || !manageFocus) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusFirstElement(sheetRef.current);
    return () => openerRef.current?.focus();
  }, [open, manageFocus]);

  useEffect(() => {
    if (!open || !manageFocus) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      trapTabKey(event, sheetRef.current);
    };
    // Capture phase, ahead of any ancestor popover/dialog listening on
    // `document` — same reasoning as OptionMenu: the sheet is a layer of its
    // own, and Escape should dismiss it and go no further.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose, manageFocus]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        // Stops a tap inside the sheet from reading as an outside click to an
        // ancestor popover it happens to be portaled past (e.g. ReaderSettings) —
        // the same defensive stopPropagation OptionMenu uses for the same reason,
        // now on `pointerdown` to match what those ancestors listen for.
        onPointerDown={(event) => event.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[20px] bg-bg-surface pt-2 shadow-context${
          scroll ? "" : " overflow-hidden pb-[calc(var(--spacing-safe-bottom)+8px)]"
        }`}
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
        <div
          className={
            scroll
              ? "min-h-0 overflow-y-auto overscroll-contain pb-[calc(var(--spacing-safe-bottom)+8px)]"
              : "flex min-h-0 flex-1 flex-col"
          }
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
