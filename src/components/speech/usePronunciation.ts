import { useEffect, useRef, useState } from "react";
import { Loader2, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSpeech } from "../../hooks/useSpeech";
import type { SpeechAccent, SpeechKind } from "./types";

const NOTICE_MS = 5000;

/**
 * Shared by the card's pronounce button and the selection menu's speak row, so
 * the subtler behaviours — switching accent replays immediately, and an accent
 * the OS cannot produce explains itself instead of silently doing nothing —
 * stay identical in both places.
 */
export function usePronunciation(text: string, kind: SpeechKind) {
  const { t } = useTranslation();
  const { status, accent, accentAvailable, dependsOnSystemVoices, speak, setAccent, stop } = useSpeech();
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const trimmed = text.trim();
  const other: SpeechAccent = accent === "uk" ? "us" : "uk";
  // Dictionary audio serves both accents, so a missing OS voice only matters
  // when system voices are what actually plays.
  const missingOther = dependsOnSystemVoices && !accentAvailable[other];

  const play = () => {
    if (status === "playing") stop();
    else speak(trimmed, kind);
  };

  const toggleAccent = async () => {
    if (missingOther) {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice(t(`speech.accentUnavailable.${other}`));
      noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
      return;
    }
    setNotice(null);
    // Switching accent and replaying is one action, not a setting plus a click.
    await setAccent(other);
    speak(trimmed, kind);
  };

  return {
    empty: trimmed.length === 0,
    status,
    notice,
    Icon: status === "loading" ? Loader2 : status === "error" ? VolumeX : Volume2,
    iconClassName: status === "loading"
      ? "animate-spin"
      : status === "playing" ? "animate-pulse" : "",
    accentLabel: t(`speech.accent.${accent}`),
    switchAccentLabel: t(`speech.switchTo.${other}`),
    playLabel: status === "error" ? t("speech.unavailable") : t("speech.play"),
    play,
    toggleAccent,
  };
}
