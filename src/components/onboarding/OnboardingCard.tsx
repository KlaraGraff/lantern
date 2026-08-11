import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { focusFirstElement, trapTabKey } from "../focus-trap";
import { Check } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { useOpenBook } from "../../hooks/useOpenBook";
import { type Book, type ImportBatchResult, IMPORT_SLOW_HINT_MS } from "../../hooks/useBooks";
import { summarizeImportFailures } from "../../hooks/import-batch";
import {
  AUTO_ANALYSIS_INTRO_KEY,
  ONBOARDING_DONE,
  ONBOARDING_STATE_KEY,
  shouldIntroduceAutoAnalysis,
  shouldShowOnboarding,
  type OnboardingStep,
} from "./onboarding-state";
import StepLevel from "./StepLevel";
import StepImport from "./StepImport";
import StepAi from "./StepAi";
import AutoAnalysisIntro from "./AutoAnalysisIntro";
import Review from "./Review";

type Phase = "steps" | "review";

/**
 * First-launch onboarding: English level, a first book, an AI service — each
 * skippable on its own, none of them blocking the other two. Mounted once,
 * next to `SettingsHost`/`McpApprovalDialog` — see `docs/impls/onboarding-
 * three-steps-mockup.html` for the design this follows.
 *
 * Visibility is derived, not owned: it drops out the instant
 * `onboarding_state` reads `"done"` in settings, whether that write came from
 * this card's own skip/finish buttons or from another window entirely.
 */
export default function OnboardingCard() {
  const { t } = useTranslation();
  const { settings, loading, save } = useSettings();
  const openBook = useOpenBook();

  const visible = !loading && shouldShowOnboarding(settings);

  const [step, setStep] = useState<OnboardingStep>(1);
  const [phase, setPhase] = useState<Phase>("steps");

  const [importing, setImporting] = useState(false);
  const [importSlow, setImportSlow] = useState(false);
  const [importedBooks, setImportedBooks] = useState<Book[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  // Set only by StepAi's own successful connection test (via the
  // "lantern:ai-config-changed" event) — not a general "is AI configured"
  // query, since the review screen only needs to know what happened in *this*
  // run to phrase its hint correctly.
  const [aiConnected, setAiConnected] = useState(false);
  // Whether this run includes the auto-analysis step. Decided when step 3
  // completes, because skipping step 3 means there is no quota to disclose
  // the spending of — and promising a fourth dot before then would advertise
  // a step that may never arrive.
  const [autoAnalysisStep, setAutoAnalysisStep] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // A closed-then-reopened card (the Settings "watch onboarding again" row)
  // should always start clean, not wherever the previous run left off.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setStep(1);
      setPhase("steps");
      setImporting(false);
      setImportSlow(false);
      setImportedBooks([]);
      setImportError(null);
      setAiConnected(false);
      setAutoAnalysisStep(false);
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const handler = () => setAiConnected(true);
    window.addEventListener("lantern:ai-config-changed", handler);
    return () => window.removeEventListener("lantern:ai-config-changed", handler);
  }, []);

  useEffect(() => {
    if (!importing) {
      setImportSlow(false);
      return;
    }
    const timer = setTimeout(() => setImportSlow(true), IMPORT_SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [importing]);

  const handleImportStart = () => {
    setImporting(true);
    setImportError(null);
  };
  // Same batch a normal toolbar import produces — the backend's own
  // `book-imported` event (emitted once per batch) is what tells `Home`'s
  // book list and sidebar counts to refresh; this only owns what the
  // onboarding card itself shows about the run.
  const handleImportDone = (result: ImportBatchResult) => {
    setImporting(false);
    if (result.imported.length > 0) setImportedBooks(result.imported);
    const failureSummary = summarizeImportFailures(result.failures);
    if (failureSummary.kind === "singleFailure") {
      setImportError(failureSummary.message);
    } else if (failureSummary.kind === "batchFailure") {
      setImportError(t("import.batchFailedCount", { count: failureSummary.failedCount }));
    }
  };
  const handleImportError = (message: string) => {
    setImporting(false);
    setImportError(message);
  };

  // Only a *completed* AI step opens the fourth one, and only if the
  // disclosure has not already been made somewhere else.
  const completeAiStep = () => {
    if (shouldIntroduceAutoAnalysis(settings)) {
      setAutoAnalysisStep(true);
      setStep(4);
    } else {
      setPhase("review");
    }
  };

  const finishAutoAnalysisStep = useCallback(() => {
    void save(AUTO_ANALYSIS_INTRO_KEY, "true");
    setPhase("review");
  }, [save]);

  const startReading = () => {
    void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE);
    // The first of the batch, when more than one was picked — there is only
    // one reader to open into.
    if (importedBooks[0]) openBook(importedBooks[0].id);
  };

  useEffect(() => {
    if (!visible) return;
    const dialog = dialogRef.current;
    focusFirstElement(dialog);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (phase === "review") {
          startReading();
        } else if (step === 4) {
          finishAutoAnalysisStep();
        } else if (step === 3) {
          void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE);
        } else {
          setStep((current) => (current >= 3 ? current : ((current + 1) as OnboardingStep)));
        }
        return;
      }
      if (event.key !== "Tab") return;
      trapTabKey(event, dialog);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, step, phase]);

  if (!visible) return null;

  const dots = autoAnalysisStep ? ([1, 2, 3, 4] as const) : ([1, 2, 3] as const);

  const progressLabel = phase === "review"
    ? t("onboarding.progress.done")
    : step === 3
      ? t("onboarding.progress.last")
      : t("onboarding.progress.stepOf", { step });

  // The 16px gutter is a floor, not the value: on a phone this card is within a
  // few points of the whole screen, so a flat 16px puts the step dots and
  // 「第 1 步，共 3 步」 underneath the status bar. Each edge takes whichever is
  // larger, the gutter or that edge's inset — and the card measures itself
  // against the padded box (`max-h-full`) rather than `100vh`, which on iOS is
  // the *largest* viewport and would push the bottom back under the home
  // indicator.
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-overlay pt-[max(1rem,var(--spacing-safe-top))] pr-[max(1rem,var(--spacing-safe-right))] pb-[max(1rem,var(--spacing-safe-bottom))] pl-[max(1rem,var(--spacing-safe-left))]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-context"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-light px-5 py-3">
          <div className="flex items-center gap-1.5">
            {dots.map((dot) => {
              const done = phase === "review" || step > dot;
              const current = phase === "steps" && step === dot;
              return (
                <span
                  key={dot}
                  className={`flex size-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                    done
                      ? "bg-success/15 text-success-text"
                      : current
                        ? "border border-accent bg-accent-bg text-accent-text"
                        : "border border-border text-text-muted"
                  }`}
                >
                  {done ? <Check size={11} /> : dot}
                </span>
              );
            })}
          </div>
          <p id={titleId} className="text-[12px] font-medium text-text-muted">{progressLabel}</p>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          {phase === "review" ? (
            <Review
              bookTitle={importedBooks[0]?.title ?? null}
              cefrLevel={settings.cefr_level ?? null}
              aiConfigured={aiConnected}
              onStartReading={startReading}
            />
          ) : step === 1 ? (
            <StepLevel
              settings={settings}
              save={save}
              onNext={() => setStep(2)}
            />
          ) : step === 2 ? (
            <StepImport
              settings={settings}
              importing={importing}
              importSlow={importSlow}
              importedBooks={importedBooks}
              importError={importError}
              onImportStart={handleImportStart}
              onImportDone={handleImportDone}
              onImportError={handleImportError}
              onNext={() => setStep(3)}
              onSkip={() => setStep(3)}
            />
          ) : step === 3 ? (
            <StepAi
              bookTitle={importedBooks[0]?.title ?? null}
              onComplete={completeAiStep}
              onSkip={() => void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE)}
            />
          ) : (
            <AutoAnalysisIntro onDone={finishAutoAnalysisStep} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
