import type { ReactNode } from "react";
import { Check } from "lucide-react";

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

// `motion-drop-in` belongs here rather than on the wrapper below: the
// wrapper is centred with `-translate-x-1/2`, and an animation there would
// overwrite the transform holding it in place.
const SURFACE =
  "motion-drop-in rounded-[14px] border border-border bg-white shadow-popover dark:bg-bg-surface";

export default function Toast({ children, icon, className = "", variant = "row" }: ToastProps) {
  return (
    // 20px below whatever the device keeps for itself up there. On a phone
    // that is the notch or the Dynamic Island, which sits in front of the page
    // and would otherwise swallow the top half of the toast; in a window with
    // no inset the term is zero and this is plain `top-5`.
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-[calc(var(--spacing-safe-top)+1.25rem)] left-1/2 z-[60] -translate-x-1/2 ${className}`}
    >
      {variant === "panel" ? (
        <div className={`overflow-hidden ${SURFACE}`}>{children}</div>
      ) : (
        <div className={`flex min-w-[260px] items-center gap-3 py-2.5 pl-4 pr-3 ${SURFACE}`}>
          {icon ?? <Check size={14} className="shrink-0 text-success-text" />}
          <span className="flex-1 whitespace-nowrap text-[13px] font-normal tracking-[-0.08px] text-text-secondary">
            {children}
          </span>
        </div>
      )}
    </div>
  );
}
