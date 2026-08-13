/**
 * 生成中屏（按篇流水线改版，样张 docs/impls/quiz-pipeline-progress-mockup.html）。
 *
 * 出卷编排是每篇文章一条独立流水线（写稿 → 校验 → 重出，见 generate.ts），
 * 全卷不再有统一的「当前阶段」，进度清单相应改成三段：
 * 拆词一行 → 每篇一行（各自显示所处阶段）→ 发卷一行。
 * 校验机制的说明收拢成篇行组下方的一行小字，不逐篇重复。
 * 「发卷」独立成一步是有意的——两阶段生成把讲解挪到发卷之后的后台去写，
 * 这一步点亮意味着可以开始做题了，不是「全部生成完了」。
 *
 * 进度条是节拍指示（各篇阶段完成度的平均值），不承诺精确百分比、不显示
 * 倒计时——生成时长本就因词数、是否触发重出而变化，编造数字比不给更误导人。
 */
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import Button from "../../components/ui/Button";
import type { ArticleProgress, GenerationStage } from "./useQuizGeneration.ts";

interface GeneratingScreenProps {
  stage: GenerationStage;
  articles: ArticleProgress[];
  wordCount: number;
  difficultyLabel: string;
  onCancel: () => void;
}

type BadgeStatus = "done" | "doing" | "pending" | "failed";

/** 各阶段折算的完成度，只喂进度条；取值只需单调递增，不代表真实耗时占比。
 * failed 也记 1：该篇流水线已 settle，进度条量的是「还要等多久」，不是成功率。 */
const ARTICLE_FRACTION: Record<ArticleProgress["step"], number> = {
  pending: 0.05,
  writing: 0.3,
  checking: 0.7,
  regenerating: 0.9,
  done: 1,
  failed: 1,
};

function StepBadge({ status, small }: { status: BadgeStatus; small?: boolean }) {
  return (
    <span
      className={`mt-0.5 flex ${small ? "size-[22px]" : "size-6"} shrink-0 items-center justify-center rounded-full border ${
        status === "done"
          ? "border-success-border bg-success-bg text-success-text"
          : status === "doing"
            ? "border-transparent bg-accent-bg text-accent-text"
            : status === "failed"
              ? "border-danger-border bg-danger-bg text-danger-text"
              : "border-border text-text-muted"
      }`}
    >
      {status === "done" && <Check size={13} strokeWidth={3} />}
      {status === "doing" && <Loader2 size={13} className="animate-spin" />}
      {(status === "pending" || status === "failed") && (
        <span className="size-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}

export default function GeneratingScreen({
  stage,
  articles,
  wordCount,
  difficultyLabel,
  onCancel,
}: GeneratingScreenProps) {
  const { t } = useTranslation();

  const progressPct =
    stage === "done"
      ? 100
      : articles.length === 0
        ? 4
        : Math.round(
            6 +
              (88 * articles.reduce((sum, a) => sum + ARTICLE_FRACTION[a.step], 0)) /
                articles.length,
          );

  const articleSubKey = (step: ArticleProgress["step"]): string => {
    switch (step) {
      case "checking":
        return "quiz.generating.step.checking";
      case "regenerating":
        return "quiz.generating.step.regenerating";
      case "done":
        return "quiz.generating.article.done";
      // 失败按篇隔离（渐进发卷）：这一篇没生成成，其余篇照常；做题页里可单篇重新生成
      case "failed":
        return "quiz.generating.article.failed";
      // pending 只在 split 建行到流水线首个事件之间瞬时存在，按「即将写稿」显示
      case "pending":
      case "writing":
        return "quiz.generating.step.writing";
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <span className="text-[15px] font-semibold text-text-primary">
          {t("quiz.generating.title")}
        </span>
        <span className="text-[12.5px] text-text-muted">
          {t("quiz.generating.subtitle", { count: wordCount, difficulty: difficultyLabel })}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("quiz.generating.cancel")}
        </Button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-[520px]">
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <StepBadge status={stage === "splitting" ? "doing" : "done"} />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-text-primary">
                  {t("quiz.generating.step.splitting")}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-[1.6] text-text-muted">
                  {t("quiz.generating.step.splitting.note")}
                  {articles.length > 0 &&
                    ` · ${t("quiz.generating.split.count", { count: articles.length })}`}
                </div>
              </div>
            </div>

            {articles.length > 0 && (
              <>
                <div className="ml-[11px] flex flex-col gap-3.5 border-l border-dashed border-border pl-6">
                  {articles.map((a, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <StepBadge
                        small
                        status={
                          a.step === "done"
                            ? "done"
                            : a.step === "failed"
                              ? "failed"
                              : a.step === "pending"
                                ? "pending"
                                : "doing"
                        }
                      />
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-text-primary">
                          {t("quiz.generating.article", { num: i + 1, count: a.wordCount })}
                        </div>
                        <div className="mt-0.5 text-[12.5px] leading-[1.6] text-text-muted">
                          {t(articleSubKey(a.step))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="ml-[11px] pl-6 text-[12px] leading-[1.7] text-text-muted">
                  {t("quiz.generating.pipeline.note")}
                </div>
              </>
            )}

            <div className="flex items-start gap-3">
              <StepBadge status={stage === "done" ? "done" : "pending"} />
              <div className="min-w-0">
                <div
                  className={`text-[14px] ${
                    stage === "done" ? "text-text-primary font-medium" : "text-text-muted"
                  }`}
                >
                  {t("quiz.generating.step.done")}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-[1.6] text-text-muted">
                  {t("quiz.generating.step.done.note")}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 h-1.5 overflow-hidden rounded-full bg-bg-input">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="mt-3 text-center text-[12.5px] text-text-muted">
            {t("quiz.generating.note")}
          </div>
        </div>
      </div>
    </div>
  );
}
