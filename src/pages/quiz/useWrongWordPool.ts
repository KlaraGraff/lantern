/**
 * 错词池数据（docs/impls/cijuan-merge-mockup.html §F）。
 *
 * 两个读法共用一个 hook：
 * - `entries`/`active`/`cleared`——「错词池」标签整表用，含已出池（默认折叠，见 PoolTab）
 * - `dueEntries`——出卷设置屏「错词重现」用，只要「现在就到期」的词（list_due_wrong_words
 *   已经按 nextDueAt<=now && !cleared 过滤好），自动混进这一卷，不提供勾选
 *
 * 错词池的重现调度（2 天→7 天两阶段机）与生词本的 FSRS 翻卡是两套并行调度，
 * 这里只读后端已经算好的结果，不在前端重算。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WrongWordEntry } from "../../quiz/types.ts";

export function useWrongWordPool() {
  const [entries, setEntries] = useState<WrongWordEntry[]>([]);
  const [dueEntries, setDueEntries] = useState<WrongWordEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [all, due] = await Promise.all([
        invoke<WrongWordEntry[]>("list_wrong_words"),
        invoke<WrongWordEntry[]>("list_due_wrong_words"),
      ]);
      setEntries(all);
      setDueEntries(due);
    } catch (err) {
      console.error("Failed to load wrong word pool:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async () => {
    await invoke("clear_wrong_words");
    await refresh();
  }, [refresh]);

  const active = entries.filter((e) => !e.cleared);
  const cleared = entries.filter((e) => e.cleared);

  return { entries, active, cleared, dueEntries, loading, refresh, clear };
}
