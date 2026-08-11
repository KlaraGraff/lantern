import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Ask the AI again after a failure.
 *
 * Distinct from the settings link it often sits beside: this changes nothing,
 * it just runs the route again — including whichever model Lantern has put on
 * cooldown, because the user pressing this outranks Lantern's own guess about
 * when that model recovers.
 */
export default function AiRetryButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 touch:min-h-11 touch:text-[15px] text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
    >
      <RotateCcw size={14} />
      {t("ai.retry")}
    </button>
  );
}
