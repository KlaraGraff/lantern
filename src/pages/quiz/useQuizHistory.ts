/**
 * 往卷列表（docs/impls/cijuan-merge-mockup.html §G）与「未交完的卷」横幅
 * （§A2）共用的数据源——list_quiz_papers 已经按新在前排好序。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rowToQuiz, type QuizPaperRow } from "./paper-io.ts";
import type { Quiz } from "../../quiz/types.ts";

export function useQuizHistory() {
  const [papers, setPapers] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await invoke<QuizPaperRow[]>("list_quiz_papers");
      setPapers(rows.map(rowToQuiz));
    } catch (err) {
      console.error("Failed to load quiz papers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 未交卷 = ready（已生成、还没交）+ generating（渐进发卷还有篇没生成完）；
  // §A2「未交完的卷」横幅、§B「上一卷」摘要都据此算
  const unfinished = papers.filter((p) => p.status !== "submitted");

  return { papers, unfinished, loading, refresh };
}

/**
 * 「8 月 12 日」风格的日期显示，词卷页三处（未交完的卷横幅、往卷列表、错词池
 * 的首次答错/下次重现日）共用。跟随界面语言而不是写死中文——沿用
 * VocabCardSnapshot.tsx 已有的 `toLocaleDateString(i18n.resolvedLanguage...)`
 * 惯例，只是这里不带年份（词卷的时间跨度短，年份价值不大，也更贴近样张）。
 */
export function formatQuizDate(iso: string, locale: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { month: "long", day: "numeric" });
}
