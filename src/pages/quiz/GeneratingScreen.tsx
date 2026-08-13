/**
 * 生成中屏（docs/impls/cijuan-merge-mockup.html §C）。
 *
 * 五步：拆词 → 撰写文章与题目 → 校验（明答+遮词并行，合并成一步展示，
 * 小字分别讲清两件事）→ 重出没通过校验的题（通常跳过，用小字说明）→ 发卷。
 * 「发卷」独立成一步是有意的——两阶段生成把讲解挪到发卷之后的后台去写，
 * 这一步点亮意味着可以开始做题了，不是「全部生成完了」。
 *
 * 进度条是节拍指示，不承诺精确百分比、不显示倒计时——生成时长本就因词数、
 * 是否触发重出而变化，编造一个数字比不给更误导人。
 */
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import Button from "../../components/ui/Button";
import type { GenerateStep } from "../../quiz/generate.ts";

const STEP_ORDER: GenerateStep[] = ["splitting", "writing", "checking", "regenerating", "done"];

interface GeneratingScreenProps {
  step: GenerateStep;
  wordCount: number;
  difficultyLabel: string;
  onCancel: () => void;
}

export default function GeneratingScreen({
  step,
  wordCount,
  difficultyLabel,
  onCancel,
}: GeneratingScreenProps) {
  const { t } = useTranslation();
  const currentIndex = STEP_ORDER.indexOf(step);
  const progressPct = Math.round(((currentIndex + 1) / STEP_ORDER.length) * 100);

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
            {STEP_ORDER.map((s, i) => {
              const status = i < currentIndex ? "done" : i === currentIndex ? "doing" : "pending";
              return (
                <div key={s} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${
                      status === "done"
                        ? "border-success-border bg-success-bg text-success-text"
                        : status === "doing"
                          ? "border-transparent bg-accent-bg text-accent-text"
                          : "border-border text-text-muted"
                    }`}
                  >
                    {status === "done" && <Check size={13} strokeWidth={3} />}
                    {status === "doing" && <Loader2 size={13} className="animate-spin" />}
                    {status === "pending" && <span className="size-1.5 rounded-full bg-current" />}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={`text-[14px] ${
                        status === "pending" ? "text-text-muted" : "text-text-primary font-medium"
                      }`}
                    >
                      {t(`quiz.generating.step.${s}`)}
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-[1.6] text-text-muted">
                      {t(`quiz.generating.step.${s}.note`)}
                    </div>
                  </div>
                </div>
              );
            })}
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
