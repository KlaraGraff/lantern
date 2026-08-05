import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { useOpenBook } from "../../hooks/useOpenBook";
import { type Book, IMPORT_SLOW_HINT_MS } from "../../hooks/useBooks";
import { ONBOARDING_DONE, ONBOARDING_STATE_KEY, shouldShowOnboarding, type OnboardingStep } from "./onboarding-state";
import StepLevel from "./StepLevel";
import StepImport from "./StepImport";
import StepAi from "./StepAi";
import Review from "./Review";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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
  const [importedBook, setImportedBook] = useState<Book | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Set only by StepAi's own successful connection test (via the
  // "lantern:ai-config-changed" event) — not a general "is AI configured"
  // query, since the review screen only needs to know what happened in *this*
  // run to phrase its hint correctly.
  const [aiConnected, setAiConnected] = useState(false);

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
      setImportedBook(null);
      setImportError(null);
      setAiConnected(false);
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
  const handleImportDone = (book: Book | null) => {
    setImporting(false);
    if (book) setImportedBook(book);
  };
  const handleImportError = (message: string) => {
    setImporting(false);
    setImportError(message);
  };

  const startReading = () => {
    void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE);
    if (importedBook) openBook(importedBook.id);
  };

  useEffect(() => {
    if (!visible) return;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (phase === "review") {
          startReading();
        } else if (step === 3) {
          void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE);
        } else {
          setStep((current) => (current >= 3 ? current : ((current + 1) as OnboardingStep)));
        }
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, step, phase]);

  if (!visible) return null;

  const progressLabel = phase === "review"
    ? t("onboarding.progress.done")
    : step === 3
      ? t("onboarding.progress.last")
      : t("onboarding.progress.stepOf", { step });

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-context"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-light px-5 py-3">
          <div className="flex items-center gap-1.5">
            {([1, 2, 3] as const).map((dot) => {
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
              bookTitle={importedBook?.title ?? null}
              cefrLevel={settings.cefr_level ?? null}
              aiConfigured={aiConnected}
              onStartReading={startReading}
            />
          ) : step === 1 ? (
            <StepLevel
              settings={settings}
              save={save}
              onNext={() => setStep(2)}
              onSkip={() => setStep(2)}
            />
          ) : step === 2 ? (
            <StepImport
              settings={settings}
              importing={importing}
              importSlow={importSlow}
              importedBook={importedBook}
              importError={importError}
              onImportStart={handleImportStart}
              onImportDone={handleImportDone}
              onImportError={handleImportError}
              onNext={() => setStep(3)}
              onSkip={() => setStep(3)}
            />
          ) : (
            <StepAi
              bookTitle={importedBook?.title ?? null}
              onComplete={() => setPhase("review")}
              onSkip={() => void save(ONBOARDING_STATE_KEY, ONBOARDING_DONE)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
