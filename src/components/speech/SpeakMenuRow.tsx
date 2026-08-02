import { useTranslation } from "react-i18next";
import { usePronunciation } from "./usePronunciation";
import type { SpeechKind } from "./types";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Plays the selection straight from the context menu, so hearing a word does
 * not require running an AI lookup first. Deliberately does not close the menu:
 * replaying and switching accent are the two things wanted right after a play.
 */
export default function SpeakMenuRow({
  text,
  kind,
  onHandOff,
}: {
  text: string;
  kind: SpeechKind;
  /**
   * Called once playback has been started, for selections long enough that the
   * menu should get out of the way. Playback outlives this row: stopping is the
   * floating control's job from here on.
   */
  onHandOff?: () => void;
}) {
  const { t } = useTranslation();
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
    <div>
      <div className="mx-1 flex h-9 w-[calc(100%-8px)] items-center rounded-sm hover:bg-accent-bg">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            // Stopping must not also dismiss the menu — only starting hands over.
            const starting = status !== "playing";
            play();
            if (starting) onHandOff?.();
          }}
          title={playLabel}
          className={`flex h-9 min-w-0 flex-1 items-center gap-3 rounded-sm px-3 text-left text-[13px] font-medium text-text-primary ${FOCUS_RING}`}
        >
          <Icon
            size={16}
            className={`shrink-0 ${status === "playing" ? "text-accent-text" : "text-text-muted"} ${iconClassName}`}
          />
          <span className="min-w-0 flex-1 truncate">{t("contextMenu.speak")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={toggleAccent}
          title={switchAccentLabel}
          aria-label={switchAccentLabel}
          className={`mr-2 flex h-[18px] shrink-0 items-center rounded border border-border/70 px-1 text-[10px] font-medium leading-none text-text-muted transition-colors hover:border-accent/60 hover:text-accent-text ${FOCUS_RING}`}
        >
          {accentLabel}
        </button>
      </div>
      {notice && (
        // Inline rather than a floating bubble: the menu is only 220px wide, so
        // an overlay would spill outside it.
        <p role="status" className="mx-1 mb-1 mt-0.5 rounded-sm bg-bg-muted px-3 py-1.5 text-[11px] leading-[15px] text-text-secondary">
          {notice}
        </p>
      )}
    </div>
  );
}
