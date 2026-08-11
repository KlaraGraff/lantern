import { ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:opacity-90 font-medium",
  secondary:
    "border border-border text-text-secondary hover:bg-bg-input font-medium",
  ghost:
    "text-text-muted hover:bg-bg-input",
  icon:
    "text-text-muted hover:bg-bg-input justify-center",
};

/**
 * The three sizes are a mouse's sizes: 32, 36 and 40px, all of them under the
 * 44px a fingertip needs. `touch:` — `(pointer: coarse)`, so a phone but not a
 * trackpad — collapses all three to 44px tall.
 *
 * Collapsing rather than scaling is deliberate. The distinction between `sm`
 * and `md` is visual density, which is a thing you can afford when the pointer
 * is a pixel wide; under a finger it is the difference between a button that
 * works and one that does not, and there is no size below 44 worth preserving.
 * Width still varies, so the sizes remain visually distinct in a row.
 *
 * Font size is left alone. Text legibility and target size are separate
 * problems, and growing type here would reflow 170 call sites for a reason
 * none of them asked for.
 */
const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-2 text-[13px] rounded-md gap-1.5 touch:h-11 touch:px-3",
  md: "h-9 px-3 text-[14px] rounded-lg gap-2 touch:h-11 touch:px-3.5",
  lg: "h-10 px-4 text-[14px] rounded-lg gap-2 touch:h-11",
};

const iconSizeStyles: Record<ButtonSize, string> = {
  sm: "size-8 rounded-md touch:size-11",
  md: "size-9 rounded-lg touch:size-11",
  lg: "size-10 rounded-lg touch:size-11",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", active, className = "", children, ...props }, ref) => {
    // `inline-flex` here means a caller cannot hide a Button with `hidden`:
    // the two classes have equal specificity and Tailwind emits `.hidden`
    // first, so `.inline-flex` wins and the button stays on screen. To drop a
    // Button at a breakpoint, stop rendering it — don't pass `hidden md:…`.
    const base = "inline-flex items-center shrink-0 cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none";
    const variantClass = active
      ? variant === "icon"
        ? "text-accent-text justify-center"
        : "bg-accent-bg text-accent-text font-medium"
      : variantStyles[variant];
    const sizeClass = variant === "icon" ? iconSizeStyles[size] : sizeStyles[size];

    return (
      <button
        ref={ref}
        className={`${base} ${variantClass} ${sizeClass} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export default Button;
