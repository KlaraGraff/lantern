import { useEffect, useRef, useState } from "react";
import { Loader2, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSpeech } from "../../hooks/useSpeech";
import type { SpeechAccent, SpeechKind } from "./types";

const NOTICE_MS = 5000;

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
  const { t } = useTranslation();
  const { status, accent, accentAvailable, dependsOnSystemVoices, speak, setAccent, stop } = useSpeech();
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const trimmed = text.trim();
  if (!trimmed) return null;

  const other: SpeechAccent = accent === "uk" ? "us" : "uk";
  const missingOther = dependsOnSystemVoices && !accentAvailable[other];
  const iconSize = size === "md" ? 16 : 14;

  const showNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const handlePlay = () => {
    if (status === "playing") stop();
    else speak(trimmed, kind);
  };

  const handleAccent = async () => {
    if (missingOther) {
      showNotice(t(`speech.accentUnavailable.${other}`));
      return;
    }
    setNotice(null);
    // Switching accent and replaying is one action, not a setting plus a click.
    await setAccent(other);
    speak(trimmed, kind);
  };

  const StatusIcon = status === "loading" ? Loader2 : status === "error" ? VolumeX : Volume2;

  return (
    <span className={`relative inline-flex shrink-0 items-center gap-0.5 ${className}`}>
      <button
        type="button"
        onClick={handlePlay}
        title={status === "error" ? t("speech.unavailable") : t("speech.play")}
        aria-label={status === "error" ? t("speech.unavailable") : t("speech.play")}
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
        <StatusIcon
          size={iconSize}
          className={status === "loading" ? "animate-spin" : status === "playing" ? "animate-pulse" : ""}
        />
      </button>
      <button
        type="button"
        onClick={handleAccent}
        title={t(`speech.switchTo.${other}`)}
        aria-label={t(`speech.switchTo.${other}`)}
        className={`flex items-center justify-center rounded border px-1 font-medium leading-none transition-colors ${
          size === "md" ? "h-[18px] text-[11px]" : "h-4 text-[10px]"
        } border-border/70 text-text-muted hover:border-accent/60 hover:text-accent-text`}
      >
        {t(`speech.accent.${accent}`)}
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
