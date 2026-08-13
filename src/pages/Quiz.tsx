/**
 * 词卷独立页（docs/impls/cijuan-merge-mockup.html §A2）。
 *
 * 占满窗口，不是弹层。一条分段导航挂三块内容：出卷（默认落地）· 错词池 · 往卷，
 * 三者共享同一个返回口（回到「单词」面板）。生成中/生成失败会接管整页，
 * 导航条让位给「取消」——避免生成过程中误点标签。
 *
 * 做题屏（§D）与评卷屏（§E）不是这一页的标签，它们是 QuizPaper.tsx 的路由
 * （/quiz/paper/:id），从「出卷」成功或「往卷」点开进入，属于并行改动，
 * 这个文件只负责 navigate 过去。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { ChevronLeft } from "lucide-react";
import SetupTab from "./quiz/SetupTab.tsx";
import PoolTab from "./quiz/PoolTab.tsx";
import HistoryTab from "./quiz/HistoryTab.tsx";
import GeneratingScreen from "./quiz/GeneratingScreen.tsx";
import { useQuizGeneration } from "./quiz/useQuizGeneration.ts";
import { useIsNarrow } from "../hooks/useIsNarrow.ts";
import { useEdgeSwipeBack } from "../hooks/useEdgeSwipeBack.ts";
import { isAiSettingsError } from "../utils/aiError.ts";
import { useWrongWordPool } from "./quiz/useWrongWordPool.ts";
import { useQuizHistory } from "./quiz/useQuizHistory.ts";
import type { Difficulty, QuestionType, QuizWord } from "../quiz/types.ts";

type TabKey = "setup" | "pool" | "history";

export default function Quiz() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // ?tab=pool / ?tab=history 允许别处直落到指定标签（评卷页「去错词池看看」）；
  // 只作初值，之后的切换不回写 URL。
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [tab, setTab] = useState<TabKey>(
    tabParam === "pool" || tabParam === "history" ? tabParam : "setup",
  );
  const generation = useQuizGeneration();
  const pool = useWrongWordPool();
  const history = useQuizHistory();

  // 生成失败时留着这份词表和设置，让「重试」不用用户重新填一遍。
  const [lastAttempt, setLastAttempt] = useState<{
    words: QuizWord[];
    config: { difficulty: Difficulty; types: QuestionType[]; maskedCheck: boolean };
  } | null>(null);

  const handleGenerate = (
    words: QuizWord[],
    config: { difficulty: Difficulty; types: QuestionType[]; maskedCheck: boolean },
  ) => {
    setLastAttempt({ words, config });
    // materialSource/model 是二期真题板块与生成留档的预留字段——v1 出卷设置屏
    // 只暴露「AI 原创」一个选项（其余两个按钮 disabled），model 由后端
    // ai_profiles + 故障切换路由决定，前端不选具体模型，这里填 'auto' 只是
    // 留档标记，generate.ts 内部不读这个字段。
    void generation.generate(words, {
      ...config,
      materialSource: "ai-original",
      model: "auto",
    });
  };

  const handleRetry = () => {
    if (!lastAttempt) return;
    handleGenerate(lastAttempt.words, lastAttempt.config);
  };

  const handleBackToSetup = () => {
    generation.dismissError();
    setTab("setup");
  };

  // 左滑返回：主屏 = 头部返回按钮（navigate(-1)），失败屏 = 「返回出卷」。
  // 生成中不接手势——那一屏唯一的出口是「取消」按钮，误触左滑不该白白
  // 作废一次已经付费的生成。
  const isNarrow = useIsNarrow();
  const { ref: swipeRef, pointerHandlers: swipeHandlers } = useEdgeSwipeBack<HTMLDivElement>({
    enabled: isNarrow && generation.phase !== "generating",
    onBack: () => {
      if (generation.phase === "error") {
        handleBackToSetup();
        return;
      }
      navigate(-1);
    },
  });

  if (generation.phase === "generating") {
    return (
      <div className="h-screen bg-bg-page">
        <GeneratingScreen
          stage={generation.stage}
          articles={generation.articles}
          wordCount={lastAttempt?.words.length ?? 0}
          difficultyLabel={lastAttempt ? t(`quiz.difficulty.${lastAttempt.config.difficulty}`) : ""}
          onCancel={generation.cancel}
        />
      </div>
    );
  }

  if (generation.phase === "error") {
    return (
      <div ref={swipeRef} {...swipeHandlers} className="flex h-screen flex-col bg-bg-page">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <span className="text-[15px] font-semibold text-text-primary">{t("quiz.error.title")}</span>
          {lastAttempt && (
            <span className="text-[12.5px] text-text-muted">
              {t("quiz.generating.subtitle", {
                count: lastAttempt.words.length,
                difficulty: t(`quiz.difficulty.${lastAttempt.config.difficulty}`),
              })}
            </span>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-[560px]">
            <div className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3.5 text-[13px] leading-[1.6] text-danger-text">
              <span className="mr-1.5 rounded bg-bg-surface/60 px-1.5 py-0.5 text-[11px] font-medium">
                {t("quiz.error.tag")}
              </span>
              {generation.error || t("quiz.error.unknown")}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                onClick={handleBackToSetup}
                className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-border px-3.5 text-[13.5px] font-medium text-text-secondary transition-colors hover:bg-bg-muted"
              >
                {t("quiz.error.backToSetup")}
              </button>
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex h-9 cursor-pointer items-center rounded-lg bg-accent px-3.5 text-[13.5px] font-medium text-white transition-colors hover:opacity-90"
              >
                {t("quiz.error.retry")}
              </button>
            </div>
            {/* 「删掉部分词缩小范围」只对生成本身的失败有意义；设置类错误（模型没配、
                钉住的模型被删）跟词表多少无关，提示了反而自相矛盾 */}
            {!isAiSettingsError(generation.errorCode) && (
              <div className="mt-3 text-center text-[12.5px] text-text-muted">{t("quiz.error.note")}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={swipeRef} {...swipeHandlers} className="flex h-screen flex-col bg-bg-page">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex h-8 cursor-pointer items-center gap-1 rounded-md px-2 text-[13.5px] font-medium text-text-secondary transition-colors hover:bg-bg-muted"
        >
          <ChevronLeft size={15} />
          {t("quiz.header.back")}
        </button>
        <span className="text-[15px] font-semibold text-text-primary">{t("quiz.header.title")}</span>
        <span className="flex-1" />
        <nav className="flex items-center gap-1 rounded-lg bg-bg-input p-[3px]">
          <TabButton active={tab === "setup"} onClick={() => setTab("setup")} label={t("quiz.tabs.setup")} />
          <TabButton
            active={tab === "pool"}
            onClick={() => setTab("pool")}
            label={t("quiz.tabs.pool")}
            count={pool.active.length}
          />
          <TabButton
            active={tab === "history"}
            onClick={() => setTab("history")}
            label={t("quiz.tabs.history")}
            count={history.papers.length}
          />
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "setup" && <SetupTab onGenerate={handleGenerate} />}
        {tab === "pool" && <PoolTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[13px] transition-colors ${
        active ? "bg-bg-surface font-semibold text-accent-text shadow-sm" : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {label}
      {typeof count === "number" && count > 0 && (
        <span
          className={`rounded-full px-1.5 text-[11px] tabular-nums ${
            active ? "bg-accent-bg text-accent-text" : "bg-bg-surface text-text-muted"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
