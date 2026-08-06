import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import Button from "../ui/Button";
import { openSettings } from "../settings-open";
import type { AutoAnalysisConsoleData } from "../settings/auto-analysis";

/**
 * The one time Lantern says out loud what it will do on its own.
 *
 * Not a question. First launch is the moment someone's estimate of this
 * app's worth is lowest, and asking then only ever gets "leave it off" —
 * which is the same as never building the feature. So the answer is already
 * chosen and the card's job is to make it easy to see and easy to undo: one
 * primary button that means "understood", one quiet way through to the
 * console for anyone who wants to pick.
 *
 * The list is read from the backend registry rather than written here. A job
 * added later then appears in this card by itself, instead of quietly
 * widening what the reader agreed to. See
 * docs/impls/auto-analysis-console-mockup.html §1.
 */
export default function AutoAnalysisIntro({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<string[] | null>(null);

  useEffect(() => {
    let disposed = false;
    invoke<AutoAnalysisConsoleData>("auto_analysis_console", { sinceMs: 0 })
      .then((data) => {
        if (!disposed) setJobs(data.jobs.filter((job) => job.enabled).map((job) => job.id));
      })
      .catch(() => {
        if (!disposed) setJobs([]);
      });
    return () => { disposed = true; };
  }, []);

  // Nothing switched on means nothing to disclose, and a card announcing an
  // empty list is worse than no card. It closes itself and counts as shown.
  useEffect(() => {
    if (jobs !== null && jobs.length === 0) onDone();
  }, [jobs, onDone]);

  if (jobs === null || jobs.length === 0) return null;

  return (
    <div>
      <h3 className="text-[15px] font-semibold text-text-primary">{t("onboarding.autoAnalysis.title")}</h3>
      <p className="mt-2 text-[12.5px] leading-[1.65] text-text-secondary">
        {t("onboarding.autoAnalysis.why")}
      </p>

      <div className="mt-4 flex flex-col gap-2.5">
        {jobs.map((id) => (
          <div key={id} className="flex items-start gap-2">
            <Check size={13} className="mt-[3px] shrink-0 text-success-text" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[12.5px] leading-[1.45] text-text-primary">
                {t(`settings.autoAnalysis.job.${id}.title`)}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-[1.5] text-text-muted">
                {t(`settings.autoAnalysis.job.${id}.sends`)}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3.5 text-[11.5px] leading-[1.6] text-text-muted">
        {t("onboarding.autoAnalysis.canTurnOff")}
      </p>

      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { openSettings("autoAnalysis"); onDone(); }}
        >
          {t("onboarding.autoAnalysis.chooseMyself")}
        </Button>
        <span className="flex-1" />
        <Button variant="primary" size="sm" onClick={onDone}>
          {t("onboarding.autoAnalysis.accept")}
        </Button>
      </div>
    </div>
  );
}
