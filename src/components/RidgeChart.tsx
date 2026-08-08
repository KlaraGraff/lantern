import { useTranslation } from "react-i18next";
import type { RidgeBar } from "./book-open-card-view";

/**
 * The bar-only half of the Book Open Card's "which chapter is hardest" block
 * (`docs/impls/book-open-card-mockup.html` §6).
 *
 * Deliberately just the bars: which sentence goes above them ("hardest
 * around X" vs "nothing stands out") differs by caller and by
 * `RidgeState.kind`, and belongs to whichever component is already reading
 * that state to pick its copy.
 */
interface RidgeChartProps {
  bars: RidgeBar[];
  showAxisLabels?: boolean;
  className?: string;
}

const TIER_CLASS: Record<RidgeBar["tier"], string> = {
  hi: "bg-accent",
  mid: "bg-accent/45",
  none: "bg-border",
};

export default function RidgeChart({
  bars,
  showAxisLabels = true,
  className = "",
}: RidgeChartProps) {
  const { t } = useTranslation();
  if (bars.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex h-12 items-stretch gap-[2px]" role="img" aria-hidden="true">
        {bars.map((bar) => (
          <div
            key={bar.sectionOrder}
            className="relative flex h-full min-w-[2px] flex-1 flex-col justify-end"
          >
            <div
              className={`w-full rounded-[1.5px] ${TIER_CLASS[bar.tier]}`}
              style={{ height: `${bar.heightPercent}%` }}
            />
          </div>
        ))}
      </div>
      {showAxisLabels ? (
        <div className="mt-1.5 flex justify-between text-[9.5px] text-text-muted">
          <span>{t("bookOpenCard.chapterAxisStart")}</span>
          <span>{t("bookOpenCard.chapterAxisEnd")}</span>
        </div>
      ) : null}
    </div>
  );
}
