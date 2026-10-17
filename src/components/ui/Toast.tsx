import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { useToastStack } from "../toast-stack";

interface ToastProps {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  /**
   * `row` — one line of text beside an icon, sized to its content. Every
   * transient confirmation in the app.
   *
   * `panel` — the same floating surface, but the caller owns everything inside
   * it: fixed width, stacked sections, its own dividers. The update prompt
   * needs this because it carries a scrollable changelog under its title row,
   * which the row layout's `items-center` and `whitespace-nowrap` cannot hold.
   */
  variant?: "row" | "panel";
}

// The entrance belongs on the surface rather than on the wrapper below: the
// wrapper is centred with `-translate-x-1/2`, and an animation there would
// overwrite the transform holding it in place.
const SURFACE =
  "rounded-[14px] border border-border bg-white shadow-popover dark:bg-bg-surface";

export default function Toast({ children, icon, className = "", variant = "row" }: ToastProps) {
  const stack = useToastStack();
  // Rises from the bottom edge in the stack, drops from the top one alone.
  const surface = `${stack ? "motion-toast-in" : "motion-drop-in"} ${SURFACE}`;
  const body =
    variant === "panel" ? (
      <div className={`overflow-hidden ${surface}`}>{children}</div>
    ) : (
      <div className={`flex min-w-[260px] max-w-full items-center gap-3 py-2.5 pl-4 pr-3 ${surface}`}>
        {icon ?? <Check size={14} className="shrink-0 text-success-text" />}
        <span className="flex-1 break-words text-[13px] font-normal tracking-[-0.08px] text-text-secondary md:whitespace-nowrap">
          {children}
        </span>
      </div>
    );

  if (stack) {
    return createPortal(
      <div role="status" aria-live="polite" className={`pointer-events-auto max-w-full ${className}`}>
        {body}
      </div>,
      stack,
    );
  }

  return (
    // 20px below whatever the device keeps for itself up there. On a phone
    // that is the notch or the Dynamic Island, which sits in front of the page
    // and would otherwise swallow the top half of the toast; in a window with
    // no inset the term is zero and this is plain `top-5`.
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-[calc(var(--spacing-safe-top)+1.25rem)] left-1/2 z-[60] max-w-[calc(100vw-2rem)] -translate-x-1/2 ${className}`}
    >
      {body}
    </div>
  );
}
