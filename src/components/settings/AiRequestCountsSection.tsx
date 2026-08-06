import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface FeatureRequestCount {
  feature: string;
  count: number;
}

interface MonthRequestCounts {
  month: string;
  total: number;
  byFeature: FeatureRequestCount[];
}

interface AiRequestCountsSummary {
  current: MonthRequestCounts;
  previousTotal: number;
}

/**
 * Slugs stored in `ai_request_counts.feature` (see
 * `crate::ai::request_counts::counted_feature`) — stable, never renamed once
 * chosen. A slug this build doesn't have a label for still shows, under its
 * raw name, rather than silently vanishing from the total.
 */
const FEATURE_LABEL_KEYS: Record<string, string> = {
  dictionary: "settings.ai.requestCounts.feature.dictionary",
  explain: "settings.ai.requestCounts.feature.explain",
  translate: "settings.ai.requestCounts.feature.translate",
  chat: "settings.ai.requestCounts.feature.chat",
  xray: "settings.ai.requestCounts.feature.xray",
  review: "settings.ai.requestCounts.feature.review",
  autoAnalysis: "settings.ai.requestCounts.feature.autoAnalysis",
  other: "settings.ai.requestCounts.feature.other",
};

/**
 * Quiet, read-only reassurance at the bottom of AI 配置 — not a dashboard.
 * Readers bring their own pay-per-use keys, so "how many times did this
 * actually call out this month" is worth showing without asking anyone to
 * reason about it from a token count.
 *
 * One request counts once no matter how many providers or keys the router
 * tried underneath it — a fallback retry after a failure is not a second
 * request from the reader's point of view. See `crate::ai::request_counts`.
 */
export default function AiRequestCountsSection() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AiRequestCountsSummary | null>(null);

  useEffect(() => {
    let active = true;
    invoke<AiRequestCountsSummary>("ai_request_counts_summary")
      .then((result) => {
        if (active) setSummary(result);
      })
      .catch(() => {
        // Quiet reassurance UI: a failed fetch just shows nothing, rather
        // than an error banner over a page about API keys.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!summary) return null;

  const rows = summary.current.byFeature.filter((row) => row.count > 0);

  return (
    <div className="mt-8">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">
        {t("settings.ai.requestCounts.groupTitle")}
      </div>
      <div className="h-px bg-border-light" />
      <div className="flex min-h-[73px] items-center justify-between gap-4 border-b border-border-light py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.ai.requestCounts.total")}
          </p>
          <p className="mt-0.5 text-[12px] text-text-muted">{t("settings.ai.requestCounts.hint")}</p>
          {summary.previousTotal > 0 && (
            <p className="mt-0.5 text-[11px] text-text-muted">
              {t("settings.ai.requestCounts.previousMonth", { count: summary.previousTotal })}
            </p>
          )}
        </div>
        <p className="shrink-0 text-[14px] font-medium text-text-primary">
          {t("settings.ai.requestCounts.count", { count: summary.current.total })}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-[12px] text-text-muted">{t("settings.ai.requestCounts.empty")}</p>
      ) : (
        <div className="space-y-1.5 py-3">
          {rows.map((row) => (
            <div
              key={row.feature}
              className="flex min-h-9 items-center justify-between gap-3 rounded-md bg-bg-input px-3"
            >
              <span className="min-w-0 truncate text-[12px] text-text-secondary">
                {t(FEATURE_LABEL_KEYS[row.feature] ?? row.feature)}
              </span>
              <span className="shrink-0 text-[12px] font-medium text-text-primary">
                {t("settings.ai.requestCounts.count", { count: row.count })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
