/**
 * 往卷标签（docs/impls/cijuan-merge-mockup.html §G）。一行一卷，点开进评卷/
 * 作答页（QuizPaper.tsx，另一并行改动owned）。日期之间不补空档，不做连续
 * 天数统计——那会把复习变成打卡（§H）。做题用时不落库，这里从不显示。
 */
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import type { Quiz } from "../../quiz/types.ts";
import { useQuizHistory, formatQuizDate } from "./useQuizHistory.ts";

const PREVIEW_CHIP_COUNT = 2;

export default function HistoryTab() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const { papers, loading } = useQuizHistory();

  if (loading) {
    return <div className="px-5 py-10 text-center text-[13px] text-text-muted">{t("quiz.history.loading")}</div>;
  }

  if (papers.length === 0) {
    return (
      <div className="mx-auto max-w-[520px] px-5 py-16 text-center">
        <div className="mb-2 text-[15px] font-medium text-text-primary">{t("quiz.history.empty.title")}</div>
        <div className="text-[13px] leading-[1.7] text-text-muted">{t("quiz.history.empty.body")}</div>
      </div>
    );
  }

  return (
    // pb carries the home indicator's inset — same reasoning as SetupTab.
    <div className="mx-auto max-w-[900px] px-2 pt-2 pb-[calc(var(--spacing-safe-bottom)+0.5rem)]">
      {papers.map((paper) => (
        <HistoryRow key={paper.id} paper={paper} locale={locale} t={t} onOpen={() => navigate(`/quiz/paper/${paper.id}`)} />
      ))}
    </div>
  );
}

function HistoryRow({
  paper,
  locale,
  t,
  onOpen,
}: {
  paper: Quiz;
  locale: string | undefined;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onOpen: () => void;
}) {
  const words = paper.words.map((w) => w.word);
  const previewed = words.slice(0, PREVIEW_CHIP_COUNT);
  const moreCount = words.length - previewed.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-3.5 border-b border-border-light px-3.5 py-3 text-left text-[13px] last:border-b-0 hover:bg-bg-muted"
    >
      <span className="min-w-[92px] font-medium text-text-primary">{formatQuizDate(paper.createdAt, locale)}</span>
      <span className="min-w-[110px] text-[12.5px] text-text-muted">
        {t("quiz.history.wordsAndDifficulty", { count: paper.words.length, difficulty: t(`quiz.difficulty.${paper.config.difficulty}`) })}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {previewed.map((w) => (
          <span key={w} className="rounded-md bg-bg-input px-2 py-0.5 text-[12px] text-text-secondary">{w}</span>
        ))}
        {moreCount > 0 && <span className="px-1 text-[12px] text-text-muted">+{moreCount}</span>}
      </span>
      {paper.status === "submitted" && paper.result ? (
        <span className="shrink-0 tabular-nums text-[14px] font-semibold text-text-primary">
          {paper.result.score} / {paper.result.total}
        </span>
      ) : paper.status === "generating" ? (
        // 渐进发卷：还有篇没生成完的卷。点开照常进做题页，未就绪篇位在那边展示
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-bg-input px-2.5 text-[11.5px] text-text-muted">
          {t("quiz.history.generating")}
        </span>
      ) : (
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-bg-input px-2.5 text-[11.5px] text-text-muted">
          {t("quiz.history.unsubmitted")}
        </span>
      )}
      <ChevronRight size={15} className="shrink-0 text-text-muted" />
    </button>
  );
}
