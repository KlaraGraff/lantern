import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, ChevronDown, ChevronRight, Check, Loader2, Upload, ExternalLink } from "lucide-react";
import Button from "../ui/Button";
import { importBookDialog, type Book } from "../../hooks/useBooks";
import { groupBookSources } from "./onboarding-state";
import { BOOK_SOURCES_KEY, resolveBookSources, type BookSourceKind } from "../book-sources";

interface StepImportProps {
  settings: Record<string, string>;
  importing: boolean;
  importSlow: boolean;
  importedBook: Book | null;
  importError: string | null;
  onImportStart: () => void;
  onImportDone: (book: Book | null) => void;
  onImportError: (message: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const SOURCE_GROUPS: BookSourceKind[] = ["library", "thirdParty"];

/**
 * Step 2 of onboarding — bring in a first book. Reuses the same import
 * command as the library's own "Choose a file…" flow. Import state is
 * lifted to `OnboardingCard` rather than owned here, because it must survive
 * moving on to step 3 — there is no backend event for this import path to
 * resume listening to if this component ever unmounted mid-import.
 */
export default function StepImport({
  settings,
  importing,
  importSlow,
  importedBook,
  importError,
  onImportStart,
  onImportDone,
  onImportError,
  onNext,
  onSkip,
}: StepImportProps) {
  const { t } = useTranslation();
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const handleChoose = async () => {
    onImportStart();
    try {
      const book = await importBookDialog.importFile();
      onImportDone(book);
    } catch (err) {
      onImportError(formatError(err));
    }
  };

  // A fresh install has no `book_sources` row, and onboarding must not create
  // one: the same resolve-don't-seed rule the settings pane follows applies
  // here, and for the same reason — a write from this screen would outrank the
  // list a device the user already owns is about to send over.
  const sources = resolveBookSources(settings[BOOK_SOURCES_KEY]);
  const grouped = groupBookSources(sources);
  const groupFor = (kind: BookSourceKind) => (kind === "library" ? grouped.library : grouped.thirdParty);

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-text-primary">{t("onboarding.step2.title")}</h2>
      <p className="mt-2 text-[13px] leading-5 text-text-secondary">{t("onboarding.step2.why")}</p>

      {importedBook ? (
        <div className="mt-5 flex items-center gap-3 rounded-md border border-border bg-bg-muted px-3 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-success/10 text-success-text">
            <Check size={16} />
          </div>
          <p className="min-w-0 truncate text-[13px] font-medium text-text-primary">
            {t("onboarding.step2.importedTitle", { title: importedBook.title })}
          </p>
        </div>
      ) : (
        <button
          type="button"
          disabled={importing}
          onClick={() => void handleChoose()}
          className="mt-5 flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-text-muted/40 py-8 text-center transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {importing ? (
            <Loader2 size={22} className="animate-spin text-accent" />
          ) : (
            <Upload size={22} className="text-text-secondary" />
          )}
          <span className="text-[14px] font-medium text-text-secondary">
            {importing ? t("home.importing") : t("onboarding.step2.chooseFile")}
          </span>
          {!importing && <span className="text-[11px] text-text-muted">{t("onboarding.step2.dropFormats")}</span>}
          {importing && importSlow && (
            <span className="max-w-[280px] text-[11px] leading-4 text-text-muted">
              {t("home.importingSlow")} {t("onboarding.step2.importSlowNonBlocking")}
            </span>
          )}
        </button>
      )}

      {importError && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-[12px] leading-5 text-danger-text">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{t("home.importError")}</p>
            <p className="mt-0.5 break-words opacity-90">{importError}</p>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-border-light pt-3">
        <button
          type="button"
          aria-expanded={sourcesOpen}
          onClick={() => setSourcesOpen((open) => !open)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-accent-text"
        >
          {sourcesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("onboarding.step2.sourcesDisclosure")}
        </button>

        {sourcesOpen && (
          <div className="mt-3 space-y-4 rounded-md border border-border bg-bg-muted p-3">
            {SOURCE_GROUPS.map((kind) => {
              const items = groupFor(kind);
              if (items.length === 0) return null;
              return (
                <div key={kind}>
                  <p className="text-[11px] font-semibold text-text-primary">
                    {t(`settings.bookSources.kindLabel.${kind}`)}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-4 text-text-muted">
                    {t(`settings.bookSources.kindHint.${kind}`)}
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {items.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => { openUrl(source.url).catch(() => {}); }}
                        className="flex w-full items-center justify-between gap-2 rounded-md bg-bg-surface px-2.5 py-2 text-left hover:border-accent"
                      >
                        <span className="min-w-0 truncate text-[12px] text-text-primary">{source.name}</span>
                        <ExternalLink size={13} className="shrink-0 text-text-muted" />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-border-light pt-4">
        <button
          type="button"
          onClick={onSkip}
          className="text-[13px] font-medium text-text-muted hover:text-text-secondary"
        >
          {t("onboarding.skip")}
        </button>
        <Button variant="primary" size="md" onClick={onNext}>
          {t("onboarding.next")}
        </Button>
      </div>
    </div>
  );
}
