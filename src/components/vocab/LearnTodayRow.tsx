import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

interface LearnTodayRowProps {
  dueCount: number;
  /** How many real books the due words come from (quiz-sourced words have none). */
  dueBookCount: number;
}

/**
 * The top of the learn workspace: today's review. It used to be the one dark
 * card on the page (canvas board 「v2 学习」), but a near-black slab on the
 * paper background read as a foreign object, so it is now a paper card like
 * the home page's today tiles — amber only where there is something to do.
 * Desktop only — a phone keeps the header button this replaces. (The 词卷
 * card that sat beside it is withdrawn for now; it lives on the
 * `feature/word-quiz` branch.)
 */
export default function LearnTodayRow({ dueCount, dueBookCount }: LearnTodayRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const due = dueCount > 0;

  return (
    <section aria-label={t("learn.today.label")} className="mb-6 hidden md:block">
      <div
        className={`flex min-w-0 items-center gap-4 rounded-[14px] border px-5 py-4 ${
          due ? "border-accent/25 bg-accent-bg/45" : "border-border-light bg-bg-surface"
        }`}
      >
        <span
          className={`flex size-12 shrink-0 items-center justify-center rounded-full border-[3px] font-serif text-[18px] font-semibold tabular-nums ${
            due ? "border-accent bg-bg-surface text-accent-text" : "border-border bg-bg-muted text-text-muted"
          }`}
        >
          {dueCount}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] font-semibold tracking-[0.08em] ${due ? "text-accent-text" : "text-text-muted"}`}>
            {t("learn.today.review")}
          </div>
          <div className="mt-0.5 truncate font-serif text-[17px] font-semibold text-text-primary">
            {due ? t("home.today.due", { count: dueCount }) : t("home.today.noneDue")}
          </div>
          {(!due || dueBookCount > 0) && (
            <div className="mt-0.5 truncate text-[12px] text-text-muted">
              {due ? t("learn.today.dueFrom", { count: dueBookCount }) : t("learn.today.noneDueDetail")}
            </div>
          )}
        </div>
        {due && (
          <button
            type="button"
            onClick={() => navigate("/flashcards")}
            className="h-9 shrink-0 cursor-pointer rounded-lg bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition-opacity duration-[var(--motion-instant)] hover:opacity-90"
          >
            {t("home.today.dueAction")}
          </button>
        )}
      </div>
    </section>
  );
}
