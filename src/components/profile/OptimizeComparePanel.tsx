import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import Button from "../ui/Button";
import AiRetryButton from "../AiRetryButton";

interface OptimizeComparePanelProps {
  /**
   * 步骤 3's split: "compress" may merge near-duplicate requirements and cut
   * filler to shrink toward the limit (`profile_compress_text`); "tidy" may
   * only reorder — one requirement per line, nothing merged, dropped, or
   * invented, and the result is allowed to come back longer
   * (`profile_tidy_text`). Every `profile.compress.*` / `profile.tidy.*` i18n
   * key this panel reads is picked by this prop, so the two modes never
   * bleed into each other's copy.
   */
  mode: "compress" | "tidy";
  originalText: string;
  softLimit: number;
  hardLimit: number;
  /** `profile_compress_text`/`profile_tidy_text` bound by the caller to match `mode` — returns the rewritten text as a bare string. */
  runText: (text: string, direction?: string) => Promise<string>;
  /** Applies the chosen text back into the editor buffer — does not save by itself. */
  onUse: (text: string) => void;
  onCancel: () => void;
}

function countClass(length: number, softLimit: number, hardLimit: number) {
  if (length > hardLimit) return "text-danger-text font-semibold";
  if (length > softLimit) return "text-warning font-semibold";
  return "text-text-muted";
}

/**
 * State ④ — one-click rewrite, side by side. Shared by both halves of 步骤
 * 3's split (`mode="compress"` / `mode="tidy"`) — same layout and flow,
 * only the copy and the bound command differ. Every rewrite call (initial
 * and re-run with direction) runs from `originalText` fresh; nothing ever
 * layers on top of a previous rewritten draft, per
 * docs/impls/user-profile-mockup.html state ④'s "每次从原文重来" note —
 * repeated rounds would otherwise drift the text unrecognizably. Neither
 * pane writes anywhere until "使用这一版" is pressed.
 */
export default function OptimizeComparePanel({
  mode,
  originalText,
  softLimit,
  hardLimit,
  runText,
  onUse,
  onCancel,
}: OptimizeComparePanelProps) {
  const { t } = useTranslation();
  const prefix = `profile.${mode}`;
  const [leftText, setLeftText] = useState(originalText);
  const [rightText, setRightText] = useState("");
  const [direction, setDirection] = useState("");
  const [loading, setLoading] = useState(true);
  const [reoptimizing, setReoptimizing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reoptimizeFailed, setReoptimizeFailed] = useState(false);

  // Separate from `reoptimizeFailed`: the *initial* load failing has nothing
  // else to show yet, so it takes over the whole panel. A re-run failure
  // happens with a working comparison already on screen — replacing it with
  // a full-panel error would throw away context the reader can still use, so
  // that path gets its own inline message near the direction row instead
  // (see the render below).
  const runInitial = useCallback(async () => {
    setFailed(false);
    try {
      const result = await runText(originalText);
      setRightText(result);
    } catch (err) {
      console.error(`Failed to ${mode} profile text:`, err);
      setFailed(true);
    }
  }, [runText, originalText, mode]);

  useEffect(() => {
    setLoading(true);
    runInitial().finally(() => setLoading(false));
    // Only ever the initial run — re-run is a separate, explicit action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rerun = async () => {
    setReoptimizing(true);
    setReoptimizeFailed(false);
    try {
      const result = await runText(originalText, direction.trim() || undefined);
      setRightText(result);
    } catch (err) {
      console.error(`Failed to re-${mode} profile text:`, err);
      setReoptimizeFailed(true);
    } finally {
      setReoptimizing(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-surface shadow-card">
      <div className="px-5 pt-4">
        <h3 className="text-[15.5px] font-semibold text-text-primary">{t(`${prefix}.title`)}</h3>
        <p className="mt-1 text-[12.3px] leading-[1.6] text-text-secondary">{t(`${prefix}.subtitle`)}</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-5 py-8 text-[13px] text-text-muted">
          <Loader2 size={16} className="animate-spin" />
          {t(`${prefix}.loading`)}
        </div>
      ) : failed ? (
        <div className="flex items-center gap-3 px-5 py-8 text-[13px] text-danger-text">
          {t(`${prefix}.failed`)}
          <AiRetryButton onClick={() => { setLoading(true); runInitial().finally(() => setLoading(false)); }} />
        </div>
      ) : (
        <>
          <div className="mt-3.5 grid grid-cols-1 gap-0 border-t border-border-light sm:grid-cols-2">
            <div className="p-4 sm:pr-5">
              <h4 className="flex items-baseline gap-2 text-[10.8px] font-bold uppercase tracking-wide text-text-muted">
                {t(`${prefix}.original`)}
                <span className="flex-1" />
                <span className={`text-[11.2px] normal-case tracking-normal ${countClass(leftText.length, softLimit, hardLimit)}`}>
                  {leftText.length} / {softLimit}
                </span>
              </h4>
              <textarea
                value={leftText}
                onChange={(event) => setLeftText(event.target.value)}
                className="mt-2 min-h-[132px] w-full resize-y rounded-lg border border-border bg-bg-surface p-2.5 text-[12.3px] leading-[1.65] text-text-primary outline-none focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={leftText.length > hardLimit}
                  onClick={() => onUse(leftText)}
                >
                  {t(`${prefix}.use`)}
                </Button>
              </div>
              {leftText.length > hardLimit && (
                <p className="mt-1.5 text-[11px] leading-[1.5] text-text-muted">{t(`${prefix}.originalStillOver`)}</p>
              )}
            </div>
            <div className="border-t border-border-light p-4 sm:border-t-0 sm:border-l sm:pl-5">
              <h4 className="flex items-baseline gap-2 text-[10.8px] font-bold uppercase tracking-wide text-accent-text">
                {t(`${prefix}.optimized`)}
                <span className="flex-1" />
                <span className={`text-[11.2px] normal-case tracking-normal ${countClass(rightText.length, softLimit, hardLimit)}`}>
                  {rightText.length} / {softLimit}
                </span>
              </h4>
              <textarea
                value={rightText}
                onChange={(event) => setRightText(event.target.value)}
                className="mt-2 min-h-[132px] w-full resize-y rounded-lg border border-lavender bg-bg-surface p-2.5 text-[12.3px] leading-[1.65] text-text-primary outline-none focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" disabled={rightText.length > hardLimit} onClick={() => onUse(rightText)}>
                  {t(`${prefix}.use`)}
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] leading-[1.5] text-text-muted">{t(`${prefix}.optimizedEditable`)}</p>
            </div>
          </div>

          <div className="border-t border-border-light bg-bg-muted px-5 py-3.5">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-text-muted">
              {t(`${prefix}.directionLabel`)}
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                type="text"
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
                placeholder={t(`${prefix}.directionPlaceholder`)}
                className="h-9 flex-1 rounded-lg border border-border bg-bg-surface px-3 text-[12.5px] text-text-primary outline-none focus:border-accent"
              />
              <Button variant="secondary" size="sm" disabled={reoptimizing} onClick={() => void rerun()}>
                {reoptimizing ? <Loader2 size={14} className="animate-spin" /> : null}
                {t(`${prefix}.reoptimize`)}
              </Button>
            </div>
            <p className="mt-2 text-[11.3px] leading-[1.6] text-text-muted">{t(`${prefix}.directionHint`)}</p>
            {reoptimizeFailed && (
              <p className="mt-1.5 text-[11.5px] leading-[1.5] text-danger-text">{t(`${prefix}.reoptimizeFailed`)}</p>
            )}
          </div>
        </>
      )}

      <div className="flex justify-end border-t border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}
