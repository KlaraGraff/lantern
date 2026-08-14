/**
 * 全应用顶部完成横幅（docs/impls/quiz-generation-background.md §B，样张状态 B）。
 *
 * 挂在 App 壳层（所有路由之上），订阅新卷生成会话（generation-session.ts 的
 * 模块级单例，同 useQuizGeneration 的接法）。触发时机是「首篇就绪」——paperId
 * 从无到有的那一刻，这一刻确实能开始做题，其余篇按渐进发卷既有设计在做题时
 * 后台补齐。判据落在「转变」而不是「此刻有 paperId」，纯函数收在
 * quiz-ready-banner.ts 方便测试：组件随时可能重新挂载/重新渲染，不能靠一次性
 * 模块标志位区分「刚出好」与「早就出好、只是这次路由切换重新读到」。
 *
 * 抑制规则每次渲染都重算，不只在触发那一刻判一次：用户如果没点「返回」、
 * 留在出题中屏，会话本身也会把他导航去 /quiz/paper/{id}（useQuizGeneration），
 * 这份导航跟这里的横幅状态更新几乎同时发生——重算能保证真落到那张卷的做题页
 * 之后横幅一定收起，不会闪一下又消失。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { Check, X } from "lucide-react";
import Toast from "./ui/Toast";
import {
  getNewPaperGeneration,
  subscribeGenerationSessions,
} from "../pages/quiz/generation-session.ts";
import { isFreshlyReady, isSuppressedByRoute } from "../pages/quiz/quiz-ready-banner.ts";

const AUTO_DISMISS_MS = 10_000;

export default function QuizReadyBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSyncExternalStore(subscribeGenerationSessions, getNewPaperGeneration);

  const [readyPaperId, setReadyPaperId] = useState<number | null>(null);
  // 挂载时若会话已带 paperId（比如刚出好那一刻这个组件才第一次挂载），不算
  // 「从无到有」——同 useQuizGeneration 的导航判据，避免挂载即弹。
  const prevPaperIdRef = useRef<number | null>(session?.paperId ?? null);

  useEffect(() => {
    const paperId = session?.paperId ?? null;
    if (isFreshlyReady(prevPaperIdRef.current, paperId)) {
      setReadyPaperId(paperId);
    }
    prevPaperIdRef.current = paperId;
  }, [session?.paperId]);

  useEffect(() => {
    if (readyPaperId == null) return;
    const timer = setTimeout(() => setReadyPaperId(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [readyPaperId]);

  if (readyPaperId == null || isSuppressedByRoute(location.pathname, readyPaperId)) return null;

  return (
    <Toast icon={<Check size={14} className="shrink-0 text-success-text" />}>
      <span className="flex items-center gap-3">
        <span className="flex-1">{t("quiz.readyBanner.message")}</span>
        <button
          type="button"
          onClick={() => {
            const paperId = readyPaperId;
            setReadyPaperId(null);
            navigate(`/quiz/paper/${paperId}`);
          }}
          className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-white"
        >
          {t("quiz.readyBanner.action")}
        </button>
        <button
          type="button"
          onClick={() => setReadyPaperId(null)}
          aria-label={t("quiz.readyBanner.dismiss")}
          title={t("quiz.readyBanner.dismiss")}
          className="tap-44 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </span>
    </Toast>
  );
}
