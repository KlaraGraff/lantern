import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import Button from "../ui/Button";

interface ReviewProps {
  bookTitle: string | null;
  cefrLevel: string | null;
  aiConfigured: boolean;
  onStartReading: () => void;
}

/**
 * The closing screen once all three steps are behind the reader, whether
 * each one finished or was skipped. `bookTitle`/`cefrLevel`/`aiConfigured`
 * simply reflect whatever settings actually hold at this point — there is no
 * separate "what happened in this session" bookkeeping.
 */
export default function Review({ bookTitle, cefrLevel, aiConfigured, onStartReading }: ReviewProps) {
  const { t } = useTranslation();

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-text-primary">{t("onboarding.review.title")}</h2>
      <p className="mt-2 text-[13px] leading-5 text-text-secondary">
        {bookTitle ? t("onboarding.review.why", { title: bookTitle }) : t("onboarding.review.whyFallback")}
      </p>

      <div className="mt-5 rounded-lg border border-border bg-bg-muted p-4">
        <p className="text-[10px] font-medium uppercase tracking-[0.5px] text-text-muted">
          {t("onboarding.review.demoLabel")}
        </p>
        <div className="mt-2 flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-bg text-accent-text">
            <BookOpen size={15} />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] leading-5 text-text-primary">
              It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in
              want of a <span className="rounded bg-accent-bg px-1 py-0.5 font-medium text-accent-text">wife</span>.
            </p>
            <p className="mt-1 text-[11px] text-text-muted">Pride and Prejudice</p>
          </div>
        </div>
      </div>

      <p className="mt-3 text-[12px] leading-5 text-text-muted">
        {aiConfigured
          ? t("onboarding.review.aiConnectedHint", { level: cefrLevel ?? "B1" })
          : t("onboarding.review.aiNotConnectedHint")}
      </p>

      <div className="mt-6 flex justify-end border-t border-border-light pt-4">
        <Button variant="primary" size="md" onClick={onStartReading}>
          {t("onboarding.review.startReading")}
        </Button>
      </div>
    </div>
  );
}
