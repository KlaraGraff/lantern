import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import Toggle from "../ui/Toggle";
import { presetFor } from "./aiPresets";
import {
  compactTokens,
  consoleWindowStart,
  groupJobsByTrigger,
  needsUnit,
  tokenScaleFor,
  type AutoAnalysisConsoleData,
  type AutoAnalysisJobView,
} from "./auto-analysis";

/**
 * The one place a system-initiated AI call can be authorised or refused.
 * See docs/impls/auto-analysis-console-mockup.html.
 *
 * Three things carry this screen, and none of them is the switch:
 *
 * - **The headline ratio.** Not a currency figure — cache hits, off-peak
 *   pricing and tiered first-input rates are things only the provider can
 *   compute, and a quietly wrong number about someone's bill is worse than
 *   no number. Token counts are exact because the provider returned them,
 *   and comparing them to the reader's own manual spend answers what they
 *   were really asking: is this costing me anything.
 * - **The "what leaves this device" line on every row.** These calls happen
 *   without anyone pressing anything, so what they send has to be stated to
 *   someone's face, not buried in a privacy page.
 * - **The "still available by hand" line on a switched-off row.** Turning a
 *   job off removes the automatic trigger, never the feature. Saying so is
 *   what makes the switch cheap to flip.
 */
export default function AutoAnalysisSettings() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<AutoAnalysisConsoleData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const scale = tokenScaleFor(i18n.language);

  const load = useCallback(async () => {
    const console_ = await invoke<AutoAnalysisConsoleData>("auto_analysis_console", {
      sinceMs: consoleWindowStart(Date.now()),
    });
    setData(console_);
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<AutoAnalysisConsoleData>("auto_analysis_console", {
      sinceMs: consoleWindowStart(Date.now()),
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = async (jobId: string, enabled: boolean) => {
    setBusy(jobId);
    try {
      await invoke("set_auto_analysis_enabled", { jobId, enabled });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const turnEverythingOff = async () => {
    if (!data) return;
    setBusy("*");
    try {
      for (const job of data.jobs) {
        if (job.enabled) await invoke("set_auto_analysis_enabled", { jobId: job.id, enabled: false });
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  // Loading renders nothing rather than a skeleton. This is a settings pane
  // the reader navigated to on purpose; a flash of grey bars where the
  // numbers will be is worse than a beat of nothing.
  if (!data) return null;

  const anyEnabled = data.jobs.some((job) => job.enabled);
  const tokenLabel = (tokens: number) =>
    needsUnit(tokens, scale)
      ? t(`settings.autoAnalysis.tokens.${scale}`, { amount: compactTokens(tokens, scale) })
      : t("settings.autoAnalysis.tokens.plain", { amount: compactTokens(tokens, scale) });
  const billingLinks = data.providers
    .map((provider) => ({ provider, url: presetFor(provider)?.usagePage ?? null }))
    .filter((entry): entry is { provider: string; url: string } => entry.url !== null);

  return (
    <div className="flex flex-col">
      <p className="pb-4 text-[12.5px] leading-[1.65] text-text-muted">
        {t("settings.autoAnalysis.lede")}
      </p>

      <div className="flex items-center gap-3 rounded-[10px] border border-accent-bg bg-accent-bg px-3.5 py-3">
        <div className="min-w-0">
          {/* The ratio leads when there is one. With no manual spend to
              compare against it is not "0%" — it is a question that has no
              answer yet, so the total stands alone instead. */}
          {data.ratioPercent !== null && (
            <p className="text-[17px] font-semibold tabular-nums text-accent-text">
              {t("settings.autoAnalysis.spend.ratio", { percent: data.ratioPercent })}
            </p>
          )}
          <p className="mt-0.5 text-[12px] leading-[1.5] text-text-secondary">
            {t("settings.autoAnalysis.spend.total", { tokens: tokenLabel(data.autoTokens) })}
            {data.ratioPercent !== null && (
              <>
                <br />
                {t("settings.autoAnalysis.spend.comparison", { percent: data.ratioPercent })}
              </>
            )}
          </p>
        </div>
        {anyEnabled && (
          <button
            type="button"
            onClick={turnEverythingOff}
            disabled={busy !== null}
            className="ml-auto shrink-0 rounded px-1.5 py-1 text-[12px] text-text-muted hover:text-text-primary disabled:opacity-50 cursor-pointer"
          >
            {t("settings.autoAnalysis.turnAllOff")}
          </button>
        )}
      </div>

      {groupJobsByTrigger(data.jobs).map(([trigger, jobs]) => (
        <section key={trigger} className="mt-5">
          <h3 className="border-b border-black/10 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.6px] text-text-muted">
            {t(`settings.autoAnalysis.trigger.${trigger}`, {
              defaultValue: t("settings.autoAnalysis.trigger.unknown"),
            })}
          </h3>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              busy={busy !== null}
              tokenLabel={tokenLabel}
              onToggle={(enabled) => setEnabled(job.id, enabled)}
            />
          ))}
        </section>
      ))}

      <div className="mt-5 flex flex-col gap-1.5 border-t border-black/10 pt-3.5 text-[11.5px] leading-[1.6] text-text-muted">
        <p>
          {t("settings.autoAnalysis.footer.noMoney")}
          {billingLinks.map((entry) => (
            <button
              key={entry.provider}
              type="button"
              onClick={() => openUrl(entry.url).catch(() => {})}
              className="ml-1.5 inline-flex items-center gap-0.5 text-accent-text hover:underline cursor-pointer"
            >
              {t("settings.autoAnalysis.footer.usagePage", {
                provider: t(presetFor(entry.provider)?.nameKey ?? "", {
                  defaultValue: entry.provider,
                }),
              })}
              <ExternalLink size={10} className="shrink-0" />
            </button>
          ))}
        </p>
        <p>{t("settings.autoAnalysis.footer.silentFailure")}</p>
        <p>{t("settings.autoAnalysis.footer.manualRemains")}</p>
      </div>
    </div>
  );
}

function JobRow({
  job,
  busy,
  tokenLabel,
  onToggle,
}: {
  job: AutoAnalysisJobView;
  busy: boolean;
  tokenLabel: (tokens: number) => string;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const title = t(`settings.autoAnalysis.job.${job.id}.title`);
  return (
    <div className="flex items-start justify-between gap-3 border-b border-black/10 py-3 last:border-b-0">
      <div className="min-w-0">
        <p
          className={`text-[13.5px] font-medium leading-[1.4] ${job.enabled ? "text-text-primary" : "text-text-muted"}`}
        >
          {title}
        </p>
        <p
          className={`mt-1 text-[11.5px] leading-[1.55] ${job.enabled ? "text-text-secondary" : "text-text-muted"}`}
        >
          {t(`settings.autoAnalysis.job.${job.id}.what`)}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-[1.5] text-text-muted">
          <span>
            {job.autoCalls > 0
              ? t("settings.autoAnalysis.ranTimes", {
                  times: job.autoCalls,
                  tokens: tokenLabel(job.autoTokens),
                })
              : t("settings.autoAnalysis.neverRan")}
          </span>
          {/* Amber, not muted: nobody pressed a button for this, so what
              goes out has to be the line that catches the eye. */}
          <span className="text-warning">
            {t(`settings.autoAnalysis.job.${job.id}.sends`)}
          </span>
        </div>
        {!job.enabled && (
          <p className="mt-1.5 text-[11px] leading-[1.5] text-accent-text">
            {t(`settings.autoAnalysis.job.${job.id}.offButManual`)}
          </p>
        )}
      </div>
      <Toggle
        checked={job.enabled}
        disabled={busy}
        onChange={onToggle}
        label={title}
      />
    </div>
  );
}
