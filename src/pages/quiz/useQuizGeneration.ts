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
import { invoke } from "@tauri-apps/api/core";
import { generateQuiz, type GenerateStep } from "../../quiz/generate.ts";
import { cancelRequest } from "../../quiz/transport.ts";
import type { QuizConfig, QuizWord } from "../../quiz/types.ts";
import { quizContentJson } from "./paper-io.ts";
import { runExplanationSession } from "./explanation-session.ts";

export type QuizGenerationPhase = "idle" | "generating" | "error";

export function useQuizGeneration() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<QuizGenerationPhase>("idle");
  const [step, setStep] = useState<GenerateStep>("splitting");
  const [error, setError] = useState<string | null>(null);
  const registryRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef(false);

  const generate = useCallback(
    async (words: QuizWord[], config: QuizConfig) => {
      cancelledRef.current = false;
      registryRef.current = new Set();
      setError(null);
      setStep("splitting");
      setPhase("generating");

      try {
        const { quiz, traces } = await generateQuiz({
          words,
          config,
          onProgress: (s) => {
            if (!cancelledRef.current) setStep(s);
          },
          requestRegistry: registryRef.current,
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
        void runExplanationSession({ paperId: id, quiz: { ...quiz, id }, traces });

        setPhase("idle");
        navigate(`/quiz/paper/${id}`);
      } catch (err) {
        if (cancelledRef.current) return;
        console.error("Quiz generation failed:", err);
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    },
    [navigate],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    for (const requestId of registryRef.current) {
      cancelRequest(requestId).catch(() => {});
    }
    registryRef.current.clear();
    setPhase("idle");
    setError(null);
  }, []);

  const dismissError = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  return { phase, step, error, generate, cancel, dismissError };
}
