import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface ReaderZoneGuideProps {
  /** With one-hand mode already on, the left column must not teach a zone
   * that no longer exists — it pages forward like the right one. */
  oneHand: boolean;
  onDismiss: () => void;
}

/**
 * The one-time overlay that introduces the phone reader's tap zones: shown on
 * the first paginated narrow open, dismissed by a tap anywhere, never again
 * (see `zone-guide.ts` for the flag). Tap-to-turn is a new behavior with no
 * visible affordance, so the first encounter explains itself once — the same
 * way an e-ink reader's first boot does.
 *
 * Portaled to <body>: the reader shell is a stack of positioned containers
 * (panels, floating bars, the read-aloud overlay), and the guide must sit on
 * the whole screen regardless of which of them exist right now. z-50 puts it
 * above the summoned bars (z-30) and scrims (z-40) but below settings and
 * toasts (z-[60]) — a toast still outranks a tutorial.
 */
export default function ReaderZoneGuide({ oneHand, onDismiss }: ReaderZoneGuideProps) {
  const { t } = useTranslation();
  const column = "flex flex-1 flex-col items-center justify-center gap-2 px-3 text-center text-white";
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex select-none flex-col bg-zinc-900/60"
      onClick={onDismiss}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Escape" || event.key === " ") onDismiss();
      }}
      aria-label={t("reader.zoneGuide.dismiss")}
    >
      <div className="flex min-h-0 flex-1 pt-safe-top">
        <div className={column}>
          <div className="text-lg font-semibold">
            {oneHand ? t("reader.zoneGuide.oneHandLeft") : t("reader.zoneGuide.previous")}
          </div>
          <div className="text-sm opacity-90">
            {oneHand ? t("reader.zoneGuide.oneHandLeftHint") : t("reader.zoneGuide.previousHint")}
          </div>
        </div>
        <div className={`${column} border-l border-dashed border-white/35`}>
          {/* The middle column teaches the lookup, not the controls: a tap here
              lands on a word far more often than it misses one, so promising
              the controls in this column would be promising the rarer outcome.
              The controls get the last line, pointing at the strip that always
              answers. */}
          <div className="text-lg font-semibold">{t("reader.zoneGuide.lookup")}</div>
          <div className="text-sm opacity-90">{t("reader.zoneGuide.lookupHint")}</div>
          <div className="mt-3.5 text-sm opacity-65">{t("reader.zoneGuide.menuHint")}</div>
        </div>
        <div className={`${column} border-l border-dashed border-white/35`}>
          <div className="text-lg font-semibold">{t("reader.zoneGuide.next")}</div>
          <div className="text-sm opacity-90">{t("reader.zoneGuide.nextHint")}</div>
        </div>
      </div>
      <div className="flex shrink-0 justify-center pb-[max(1.5rem,var(--spacing-safe-bottom))]">
        <span className="rounded-full bg-white/15 px-5 py-2 text-sm text-white">
          {t("reader.zoneGuide.dismiss")}
        </span>
      </div>
    </div>,
    document.body,
  );
}
