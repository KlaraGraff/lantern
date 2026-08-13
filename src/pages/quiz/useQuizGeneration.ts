/**
 * 出卷编排（docs/impls/cijuan-merge.md §二.6 两阶段生成 · 步骤 4 UI 实现）。
 *
 * 流程：generateQuiz（阶段一：出题+明答校验+遮词自检+重出，见 src/quiz/generate.ts）
 * → create_quiz_paper 落库拿到 id → fire-and-forget 起 runExplanationSession
 *   （阶段二：解析续写，在后台跑，不阻塞跳转）→ 跳到做题页。
 *
 * 取消：把 requestRegistry 传给 generateQuiz——它在每次底层 complete 调用前生成
 * 全新 uuid 登记进这个 Set，settle 后摘除（见 generate.ts 的 withRequestRegistry）。
 * 「生成中屏」点取消时，对 registry 里当时还在场的每个 id 调 transport 的
 * cancelRequest，再把本地状态打回 idle、放弃任何已经拿到的部分结果——不落库、
 * 不导航。cancelledRef 是必须的：cancelRequest 只是通知后端别再流式返回，
 * 已经在飞的 Promise 仍会 resolve/reject，若不拦一道，取消后还是会继续走
 * create_quiz_paper → 跳转，等于取消没生效。
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { generateQuiz, type ArticleStep } from "../../quiz/generate.ts";
import { cancelRequest, parseQuizAiProfileId } from "../../quiz/transport.ts";
import type { QuizConfig, QuizWord } from "../../quiz/types.ts";
import { quizContentJson } from "./paper-io.ts";
import { runExplanationSession } from "./explanation-session.ts";
import { useSettings } from "../../hooks/useSettings.ts";
import { aiErrorMessageKey, getAiErrorCode, type AiErrorCode } from "../../utils/aiError.ts";

export type QuizGenerationPhase = "idle" | "generating" | "error";

/** 生成中屏的宏观阶段：拆词中 → 各篇流水线推进中 → 发卷（随即导航离开） */
export type GenerationStage = "splitting" | "articles" | "done";

/**
 * 生成中屏的按篇状态行。`pending` 只存在于 split 事件建行到该篇第一个
 * article 事件之间——各篇流水线在拆词后同步启动，正常情况下用户看不到它，
 * 但保留这个初值能让「事件乱序/丢失」时 UI 不至于显示错误的阶段。
 */
export interface ArticleProgress {
  wordCount: number;
  step: ArticleStep | "pending";
}

export function useQuizGeneration() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [phase, setPhase] = useState<QuizGenerationPhase>("idle");
  const [stage, setStage] = useState<GenerationStage>("splitting");
  const [articles, setArticles] = useState<ArticleProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 识别出的 AI 错误码（如 AI_PROFILE_NOT_AVAILABLE）；错误页据此决定
  // 「删掉部分词缩小范围」这类建议是否适用——设置类错误跟词表多少无关。
  const [errorCode, setErrorCode] = useState<AiErrorCode | null>(null);
  const registryRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef(false);

  const generate = useCallback(
    async (words: QuizWord[], config: QuizConfig) => {
      cancelledRef.current = false;
      registryRef.current = new Set();
      setError(null);
      setErrorCode(null);
      setStage("splitting");
      setArticles([]);
      setPhase("generating");
      const profileId = parseQuizAiProfileId(settings["quiz_ai_profile_id"]);

      try {
        const { quiz, traces } = await generateQuiz({
          words,
          config,
          // 把 generate.ts 的进度事件流聚合成生成中屏要的状态：
          // split 一次性建行（此后行数不变），article 事件推进对应行的阶段
          onProgress: (p) => {
            if (cancelledRef.current) return;
            if (p.type === "splitting") {
              setStage("splitting");
              setArticles([]);
            } else if (p.type === "split") {
              setStage("articles");
              setArticles(p.articles.map((a) => ({ wordCount: a.wordCount, step: "pending" })));
            } else if (p.type === "article") {
              setArticles((prev) =>
                prev.map((a, i) => (i === p.index ? { ...a, step: p.step } : a)),
              );
            } else {
              setStage("done");
            }
          },
          requestRegistry: registryRef.current,
          profileId,
        });
        if (cancelledRef.current) return;

        const createdAt = new Date().toISOString();
        const id = await invoke<number>("create_quiz_paper", {
          createdAt,
          configJson: JSON.stringify(quiz.config),
          wordsJson: JSON.stringify(quiz.words),
          contentJson: quizContentJson(quiz),
        });
        if (cancelledRef.current) return;

        // 阶段二解析续写：不 await，跨路由继续跑（见 explanation-session.ts 顶部说明）
        void runExplanationSession({ paperId: id, quiz: { ...quiz, id }, traces, profileId });

        setPhase("idle");
        navigate(`/quiz/paper/${id}`);
      } catch (err) {
        if (cancelledRef.current) return;
        // 某篇写稿失败 → generateQuiz 整体 reject，卷子已注定不发。其余流水线
        // 里仍在飞的请求（registry 里剩下的 id）此刻只会白烧计费流——照
        // cancel() 的路数逐个通知后端掐断（generate.ts 侧的 abort 标志管
        // 「不再发起新调用」，这里管「掐掉已在飞的」，两头都要堵）。
        for (const requestId of registryRef.current) {
          cancelRequest(requestId).catch(() => {});
        }
        registryRef.current.clear();
        console.error("Quiz generation failed:", err);
        const message = err instanceof Error ? err.message : String(err);
        // 后端错误串带的是给程序看的 token；注册表认得的一律换成 i18n 文案再上屏
        const code = getAiErrorCode(err);
        setErrorCode(code);
        setError(code ? t(aiErrorMessageKey(code)) : message);
        setPhase("error");
      }
    },
    [navigate, settings, t],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    for (const requestId of registryRef.current) {
      cancelRequest(requestId).catch(() => {});
    }
    registryRef.current.clear();
    setPhase("idle");
    setError(null);
    setErrorCode(null);
  }, []);

  const dismissError = useCallback(() => {
    setPhase("idle");
    setError(null);
    setErrorCode(null);
  }, []);

  return { phase, stage, articles, error, errorCode, generate, cancel, dismissError };
}
