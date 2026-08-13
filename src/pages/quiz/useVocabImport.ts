/**
 * 出卷设置屏「从生词本导入」列表（docs/impls/cijuan-merge-mockup.html §B）。
 *
 * 只读 list_vocab_due_for_review——已经按 list_status='confirmed' 过滤好的
 * 到期待复习词，不做「全部生词」视图（§B 的「改看全部生词」链接需要一个本次
 * 未被授权的「列出全部生词」命令，未实现，见收工报告的「未做」一节）。
 *
 * 默认不勾选（对齐 §B 空态插图「未选 · 全选」，而不是已填数据示例里的「已选 2」——
 * 空态插图更权威：那是这个组件刚挂载、用户还没操作过的真实起始状态）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface VocabImportWord {
  id: string;
  word: string;
  definition: string;
}

export function useVocabImport() {
  const [words, setWords] = useState<VocabImportWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const rows = await invoke<{ id: string; word: string; definition: string }[]>(
        "list_vocab_due_for_review",
      );
      setWords(rows.map((r) => ({ id: r.id, word: r.word, definition: r.definition })));
    } catch (err) {
      console.error("Failed to load vocab due for review:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(words.map((w) => w.id)));
  }, [words]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const allSelected = words.length > 0 && selected.size === words.length;

  const selectedWords = useMemo(
    () => words.filter((w) => selected.has(w.id)),
    [words, selected],
  );

  return {
    words,
    loading,
    error,
    selected,
    selectedWords,
    allSelected,
    toggle,
    selectAll,
    clearSelection,
    refresh,
  };
}
