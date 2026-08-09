import { usePronunciation } from "./usePronunciation";
import type { SpeechKind } from "./types";

interface PronounceButtonProps {
  text: string;
  kind?: SpeechKind;
  /** `sm` sits beside a 13px card title, `md` beside a 20px word heading. */
  size?: "sm" | "md";
  className?: string;
}

export default function PronounceButton({
  text,
  kind = "word",
  size = "sm",
  className = "",
}: PronounceButtonProps) {
  const {
    empty,
    status,
    notice,
    Icon,
    iconClassName,
    accentLabel,
    switchAccentLabel,
    playLabel,
    play,
    toggleAccent,
  } = usePronunciation(text, kind);

  if (empty) return null;

  return (
    <span className={`relative inline-flex shrink-0 items-center gap-0.5 ${className}`}>
      <button
        type="button"
        onClick={play}
        title={playLabel}
        aria-label={playLabel}
        className={`flex items-center justify-center rounded-md transition-colors ${
          size === "md" ? "size-7" : "size-6"
        } ${
          status === "error"
            ? "text-text-muted"
            : status === "playing"
              ? "text-accent-text"
              : "text-text-muted hover:bg-bg-input hover:text-accent-text"
        }`}
      >
        <Icon size={size === "md" ? 16 : 14} className={iconClassName} />
      </button>
      <button
        type="button"
        onClick={toggleAccent}
        title={switchAccentLabel}
        aria-label={switchAccentLabel}
        // No border. The card header sits on the accent fill, and a boxed
        // two-letter chip there reads as a lit-up control demanding attention
        // rather than as the quiet accent label it is. The hover fill is the
        // affordance instead.
        className={`flex items-center justify-center rounded px-1 font-medium leading-none transition-colors ${
          size === "md" ? "h-[18px] text-[11px]" : "h-4 text-[10px]"
        } text-text-muted hover:bg-bg-surface/70 hover:text-accent-text`}
      >
        {accentLabel}
      </button>
      {notice && (
        <span
          role="status"
          className="absolute left-0 top-full z-10 mt-1 w-max max-w-[240px] whitespace-normal rounded-md border border-border bg-bg-surface px-2 py-1 text-[11px] leading-[15px] text-text-secondary shadow-context"
        >
          {notice}
        </span>
      )}
    </span>
  );
}
