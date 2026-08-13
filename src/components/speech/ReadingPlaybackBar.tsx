import { useEffect, useState } from "react";
import { Loader2, Pause, Play, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  cancelSpeech,
  pauseSpeech,
  playerState,
  resumeSpeech,
  subscribeToPlayer,
  subscribeToProgress,
  type SpeechPlayerState,
} from "./player";

/**
 * Below this, progress says nothing worth the space: a clip of a few seconds is
 * over before the reader has looked at it.
 */
const PROGRESS_MIN_STEPS = 2;

/**
 * Stop control for audio that outlives the menu that started it.
 *
 * A passage takes minutes to read, and the selection menu it was started from
 * closes long before then, taking its stop button with it. This appears only
 * while something is playing or waiting to be resumed, so the reader gains no
 * permanent chrome — the quiet reader looks exactly as it did.
 */
export default function ReadingPlaybackBar() {
  const { t } = useTranslation();
  const [player, setPlayer] = useState<SpeechPlayerState>(playerState);
  const [steps, setSteps] = useState({ index: 0, seen: 0 });

  useEffect(() => subscribeToPlayer(setPlayer), []);

  useEffect(() => subscribeToProgress((progress) => {
    if (!progress) {
      setSteps({ index: 0, seen: 0 });
      return;
    }
    // The queue's length is not known ahead of time — steps are produced as
    // playback approaches them — so "how far in" is counted rather than divided.
    setSteps((current) => ({
      index: progress.stepIndex,
      seen: Math.max(current.seen, progress.stepIndex + 1),
    }));
  }), []);

  // Detached playback only. A word played from a card keeps its own row, spinner
  // and replay, so a second control would appear and vanish inside a second.
  //
  // A paused passage counts even when a word is playing over the top of it:
  // that is precisely the moment the reader needs somewhere to resume from.
  const paused = player.paused !== null;
  const active = paused
    || (player.detached && (player.status === "loading" || player.status === "playing"));
  if (!active) return null;

  const loading = !paused && player.status === "loading";

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border-light bg-bg-elevated/95 px-3 py-1.5 shadow-lg backdrop-blur"
    >
      {loading
        ? <Loader2 size={14} className="animate-spin text-text-muted" />
        : <Volume2 size={14} className={paused ? "text-text-muted" : "animate-pulse text-accent-text"} />}
      <span className="text-[12px] leading-none text-text-secondary">
        {paused
          ? t("speech.playback.paused")
          : loading
            ? t("speech.playback.preparing")
            : steps.seen >= PROGRESS_MIN_STEPS
              ? t("speech.playback.part", { current: steps.index + 1 })
              : t("speech.playback.reading")}
      </span>
      <button
        type="button"
        onClick={paused ? resumeSpeech : pauseSpeech}
        title={paused ? t("speech.playback.resume") : t("speech.playback.pause")}
        aria-label={paused ? t("speech.playback.resume") : t("speech.playback.pause")}
        className="tap-44 flex size-6 cursor-pointer items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-input hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {paused
          ? <Play size={11} fill="currentColor" />
          : <Pause size={11} fill="currentColor" />}
      </button>
      <button
        type="button"
        onClick={cancelSpeech}
        title={t("speech.playback.stop")}
        aria-label={t("speech.playback.stop")}
        className="tap-44 flex size-6 cursor-pointer items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-input hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}
