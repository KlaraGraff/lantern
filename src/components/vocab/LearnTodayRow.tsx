import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

interface LearnTodayRowProps {
  dueCount: number;
  /** How many real books the due words come from (quiz-sourced words have none). */
  dueBookCount: number;
}

/**
 * The top of the learn workspace (canvas board 「v2 学习」): today's review as
 * the one dark card on the page. Desktop only — a phone keeps the header
 * button this replaces. (The 词卷 card that sat beside it is withdrawn for
 * now; it lives on the `feature/word-quiz` branch.)
 */
export default function LearnTodayRow({ dueCount, dueBookCount }: LearnTodayRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <section aria-label={t("learn.today.label")} className="mb-6 hidden md:block">
      <div className="flex min-w-0 items-center gap-4 rounded-[14px] bg-text-primary px-5 py-[18px] text-bg-page shadow-card">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full border-[5px] border-accent font-serif text-[20px] font-semibold tabular-nums">
          {dueCount}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-accent">{t("learn.today.review")}</div>
          <div className="mt-0.5 truncate font-serif text-[18px] font-semibold">
            {dueCount > 0 ? t("home.today.due", { count: dueCount }) : t("home.today.noneDue")}
          </div>
          {(dueCount === 0 || dueBookCount > 0) && (
            <div className="mt-0.5 truncate text-[12px] opacity-70">
              {dueCount > 0 ? t("learn.today.dueFrom", { count: dueBookCount }) : t("learn.today.noneDueDetail")}
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={dueCount === 0}
          onClick={() => navigate("/flashcards")}
          className="h-9 shrink-0 cursor-pointer rounded-lg bg-accent px-4 text-[13px] font-semibold text-white transition-opacity duration-[var(--motion-instant)] hover:opacity-90 disabled:cursor-default disabled:opacity-40"
        >
          {t("home.today.dueAction")}
        </button>
      </div>
    </section>
  );
}
