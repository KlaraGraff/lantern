/**
 * 出卷入口的薄订阅层（渐进发卷改版，docs/impls/quiz-progressive-delivery.md §四）。
 *
 * 编排、落库、取消、逐篇解析全部住在 generation-session.ts（模块级会话，跨路由
 * 存活）；这个 hook 只做三件事：把会话状态翻译成出卷页要的 phase/stage/articles、
 * 把识别出的 AI 错误码换成 i18n 文案、在会话建卷（paperId 出现）的那一刻导航去
 * 做题页。导航只认「本 hook 挂载期间 paperId 从无到有」这一转变——用户中途回到
 * 出卷页时会话可能早已建卷，挂载即导航会把人强行弹走。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { parseQuizAiProfileId } from "../../quiz/transport.ts";
import type { QuizConfig, QuizWord } from "../../quiz/types.ts";
import { useSettings } from "../../hooks/useSettings.ts";
import { aiErrorMessageKey } from "../../utils/aiError.ts";
import {
  cancelGenerationSession,
  dismissGenerationSession,
  getNewPaperGeneration,
  startGenerationSession,
  subscribeGenerationSessions,
} from "./generation-session.ts";

export type QuizGenerationPhase = "idle" | "generating" | "error";

// 生成中屏的类型随会话搬去了 generation-session.ts；这里转口出去，
// GeneratingScreen 等既有引用路径不用动
export type { ArticleProgress, GenerationStage } from "./generation-session.ts";

export function useQuizGeneration() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { settings } = useSettings();
  const session = useSyncExternalStore(subscribeGenerationSessions, getNewPaperGeneration);

  // 挂载时若会话已带 paperId（用户从做题页折回出卷页），不算「从无到有」
  const prevPaperIdRef = useRef<number | null>(session?.paperId ?? null);
  useEffect(() => {
    const paperId = session?.paperId ?? null;
    if (paperId != null && prevPaperIdRef.current == null) {
      navigate(`/quiz/paper/${paperId}`);
    }
    prevPaperIdRef.current = paperId;
  }, [session?.paperId, navigate]);

  const generate = useCallback(
    async (words: QuizWord[], config: QuizConfig) => {
      startGenerationSession({
        words,
        config,
        profileId: parseQuizAiProfileId(settings["quiz_ai_profile_id"]),
      });
    },
    [settings],
  );

  const phase: QuizGenerationPhase = !session
    ? "idle"
    : session.error != null
      ? "error"
      : session.running && session.paperId == null
        ? "generating"
        : "idle";

  // 后端错误串带的是给程序看的 token；注册表认得的一律换成 i18n 文案再上屏。
  // errorCode 另给一份：错误页据此决定「删掉部分词缩小范围」这类建议是否适用
  const errorCode = session?.errorCode ?? null;
  const error = session?.error == null ? null : errorCode ? t(aiErrorMessageKey(errorCode)) : session.error;

  return {
    phase,
    stage: session?.stage ?? ("splitting" as const),
    articles: session?.articles ?? [],
    error,
    errorCode,
    generate,
    cancel: cancelGenerationSession,
    dismissError: dismissGenerationSession,
  };
}
