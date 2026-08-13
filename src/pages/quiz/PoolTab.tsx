/**
 * 错词池标签（docs/impls/cijuan-merge-mockup.html §F）。
 *
 * 只读的计划表 + 一个危险操作，不提供逐条编辑——手工改重现时间会让阶段机
 * 失去意义。已出池的词默认折叠在「展开 N 个已出池的词」后面：数据永久保留
 * 当学习履历，但默认只列在池的词，否则时间一长这张表会被出池记录淹没。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Clipboard, Trash2 } from "lucide-react";
import Button from "../../components/ui/Button";
import Toast from "../../components/ui/Toast";
import ConfirmDialog from "../../components/settings/ConfirmDialog.tsx";
import type { WrongWordEntry, WrongWordStage } from "../../quiz/types.ts";
import { useWrongWordPool } from "./useWrongWordPool.ts";
import { formatQuizDate } from "./useQuizHistory.ts";

export default function PoolTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const pool = useWrongWordPool();
  const [clearedExpanded, setClearedExpanded] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [copied, setCopied] = useState(false);
  // "待重现"判定要跟当前时间比——不能在渲染中直接调用 Date.now()（React 要求渲染
  // 是纯函数），改成状态 + 定时刷新，沿用 DictionaryContent.tsx 已有的惯例。
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const updateNow = () => setNow(Date.now());
    const timer = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    const text = pool.active.map((e) => e.word).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error("Failed to copy wrong word list:", err);
    }
  };

  const handleClear = async () => {
    await pool.clear();
    setConfirmingClear(false);
  };

  if (pool.loading) {
    return <div className="px-5 py-10 text-center text-[13px] text-text-muted">{t("quiz.pool.loading")}</div>;
  }

  if (pool.entries.length === 0) {
    return (
      <div className="mx-auto max-w-[520px] px-5 py-16 text-center">
        <div className="mb-2 text-[15px] font-medium text-text-primary">{t("quiz.pool.empty.title")}</div>
        <div className="text-[13px] leading-[1.7] text-text-muted">{t("quiz.pool.empty.body")}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] px-5 py-6">
      <div className="mb-4 rounded-lg border border-border-light bg-bg-muted px-3.5 py-3 text-[12.5px] leading-[1.6] text-text-secondary">
        <span className="mr-1.5 rounded bg-bg-input px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
          {t("quiz.pool.mechanismBanner.tag")}
        </span>
        {t("quiz.pool.mechanismBanner.body")}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <th className="px-3 py-2.5">{t("quiz.pool.table.word")}</th>
              <th className="px-3 py-2.5">{t("quiz.pool.table.wrongCount")}</th>
              <th className="px-3 py-2.5">{t("quiz.pool.table.stage")}</th>
              <th className="px-3 py-2.5">{t("quiz.pool.table.nextDue")}</th>
              <th className="px-3 py-2.5">{t("quiz.pool.table.firstWrong")}</th>
              <th className="px-3 py-2.5">{t("quiz.pool.table.status")}</th>
            </tr>
          </thead>
          <tbody>
            {pool.active.map((entry) => (
              <PoolRow key={entry.id} entry={entry} locale={locale} t={t} now={now} />
            ))}
            {clearedExpanded && pool.cleared.map((entry) => (
              <PoolRow key={entry.id} entry={entry} locale={locale} t={t} now={now} cleared />
            ))}
          </tbody>
        </table>
        {pool.cleared.length > 0 && (
          <button
            type="button"
            onClick={() => setClearedExpanded((v) => !v)}
            className="flex w-full cursor-pointer items-center justify-center gap-1.5 border-t border-border-light py-2.5 text-[12.5px] text-text-muted hover:bg-bg-muted"
          >
            {clearedExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {clearedExpanded
              ? t("quiz.pool.collapseCleared")
              : t("quiz.pool.expandCleared", { count: pool.cleared.length })}
          </button>
        )}
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={handleCopy} disabled={pool.active.length === 0}>
          <Clipboard size={14} />
          {t("quiz.pool.copyButton")}
        </Button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setConfirmingClear(true)}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-danger-text/30 px-3 text-[14px] font-medium text-danger-text transition-colors hover:bg-danger-bg"
        >
          <Trash2 size={14} />
          {t("quiz.pool.clearButton")}
        </button>
      </div>

      {copied && (
        <Toast>{t("quiz.pool.copyToast", { count: pool.active.length })}</Toast>
      )}

      {confirmingClear && (
        <ConfirmDialog
          title={t("quiz.pool.clearDialog.title")}
          description={t("quiz.pool.clearDialog.description", {
            total: pool.entries.length,
            cleared: pool.cleared.length,
          })}
          primaryLabel={t("quiz.pool.clearDialog.confirm", { count: pool.entries.length })}
          onPrimary={handleClear}
          secondaryLabel={t("quiz.pool.clearDialog.cancel")}
          onSecondary={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}

function stageLabel(stage: WrongWordStage, t: (key: string) => string): string {
  return stage === 0 ? t("quiz.pool.stage.first") : t("quiz.pool.stage.second");
}

function PoolRow({
  entry,
  locale,
  t,
  now,
  cleared,
}: {
  entry: WrongWordEntry;
  locale: string | undefined;
  t: (key: string, opts?: Record<string, unknown>) => string;
  now: number;
  cleared?: boolean;
}) {
  const isDueToday = !cleared && entry.nextDueAt !== null && new Date(entry.nextDueAt).getTime() <= now;
  return (
    <tr className={`border-t border-border-light ${cleared ? "opacity-55" : ""}`}>
      <td className="px-3 py-2.5 font-serif text-[14px] text-text-primary">{entry.word}</td>
      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{entry.wrongCount}</td>
      <td className="px-3 py-2.5 text-text-secondary">{cleared ? "—" : stageLabel(entry.stage, t)}</td>
      <td className="px-3 py-2.5 tabular-nums text-text-secondary">
        {cleared || !entry.nextDueAt ? "—" : formatQuizDate(entry.nextDueAt, locale)}
      </td>
      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatQuizDate(entry.firstWrongAt, locale)}</td>
      <td className="px-3 py-2.5">
        {cleared ? (
          <span className="inline-flex h-6 items-center rounded-full bg-success-bg px-2.5 text-[11.5px] font-medium text-success-text">
            {t("quiz.pool.status.cleared")}
          </span>
        ) : isDueToday ? (
          <span className="inline-flex h-6 items-center rounded-full bg-accent-bg px-2.5 text-[11.5px] font-semibold text-accent-text">
            {t("quiz.pool.status.dueToday")}
          </span>
        ) : (
          <span className="inline-flex h-6 items-center rounded-full bg-bg-input px-2.5 text-[11.5px] text-text-muted">
            {t("quiz.pool.status.waiting")}
          </span>
        )}
      </td>
    </tr>
  );
}
