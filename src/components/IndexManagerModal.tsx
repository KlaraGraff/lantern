import { ReactNode, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Database, Loader2, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";
import PersonAliasesSection from "./PersonAliasesSection";
import { createUuid } from "../utils/randomUuid";
import {
  deriveBookIndexState,
  phaseTrail,
  runOutcome,
  visibleCounters,
  type IndexDetails,
  type IndexProgress,
  type SummaryCounters,
} from "./index-state";
import { runningBook, type BatchIndexProgress } from "./settings/library-index";

/** One of the four counters across the top. */
const STAT_VALUE_TONE = {
  flag: "text-warning",
  good: "text-success-text",
  busy: "text-accent-text",
} as const;

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: keyof typeof STAT_VALUE_TONE }) {
  return (
    <div className={`rounded-md border p-3 ${tone === "flag" ? "border-warning/40 bg-warning/10" : "border-border"}`}>
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className={`mt-1 truncate text-[13px] font-medium ${tone ? STAT_VALUE_TONE[tone] : "text-text-primary"}`}>
        {value}
      </p>
    </div>
  );
}

export default function IndexManagerModal({
  bookId,
  bookTitle,
  focusAlias,
  onClose,
}: {
  bookId: string;
  /** Optional: the header falls back to the generic name without it. */
  bookTitle?: string;
  /** Opened from the disclosure line above an answer (D9): land the alias
   *  section on this alias instead of the top of the modal. */
  focusAlias?: string;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const [details, setDetails] = useState<IndexDetails | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overviewDraft, setOverviewDraft] = useState("");
  const [sectionDrafts, setSectionDrafts] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [summaryCounters, setSummaryCounters] = useState<SummaryCounters | null>(null);
  const [running, setRunning] = useState(false);
  const [batch, setBatch] = useState<BatchIndexProgress | null>(null);
  const [confirmRechunk, setConfirmRechunk] = useState(false);
  const hasEditedSummary = Boolean(details?.overview?.userEdited || details?.sections.some((section) => section.userEdited));

  const load = useCallback(async () => {
    const next = await invoke<IndexDetails>("ai_index_details", { bookId });
    setDetails(next);
    setOverviewDraft(next.overview?.content ?? "");
    setSectionDrafts(Object.fromEntries(next.sections
      .filter((section) => section.sectionIndex != null)
      .map((section) => [section.sectionIndex!, section.content])));
  }, [bookId]);

  useEffect(() => { void load().catch((reason) => setError(String(reason))); }, [load]);

  // `ai_update_book_index` returns the moment it has spawned its task, so
  // everything the reader learns about the run arrives on these two channels.
  // The summary channel is the pre-existing one; it is read only to fill in
  // the counters the index channel says it does not have.
  useEffect(() => {
    let disposed = false;
    const stops: UnlistenFn[] = [];
    const track = (pending: Promise<UnlistenFn>) => {
      pending
        .then((stop) => { if (disposed) stop(); else stops.push(stop); })
        .catch(() => {});
    };
    track(listen<IndexProgress>(`ai-index-progress-${bookId}`, (event) => {
      if (disposed) return;
      const next = event.payload;
      setProgress(next);
      if (next.state === "running") {
        // Also catches a run that was already going when the modal opened.
        setRunning(true);
        return;
      }
      setRunning(false);
      setSummaryCounters(null);
      void load().catch((reason) => setError(String(reason)));
    }));
    track(listen<SummaryCounters>(`ai-summary-progress-${bookId}`, (event) => {
      if (!disposed) setSummaryCounters(event.payload);
    }));
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [bookId, load]);

  // Whether this book happens to be the one the whole-library batch is
  // currently indexing — read once on open and kept live, purely so the stop
  // button can say what it is really about to do. A snapshot that has not
  // answered yet leaves `batch` at `null`, which renders nothing rather than
  // a warning that might be wrong.
  useEffect(() => {
    let disposed = false;
    const stops: UnlistenFn[] = [];
    const track = (pending: Promise<UnlistenFn>) => {
      pending
        .then((stop) => { if (disposed) stop(); else stops.push(stop); })
        .catch(() => {});
    };
    invoke<BatchIndexProgress | null>("ai_index_all_books_status")
      .then((next) => { if (!disposed) setBatch(next ?? null); })
      .catch(() => {});
    track(listen<BatchIndexProgress>("ai-index-all-progress", (event) => {
      if (!disposed) setBatch(event.payload);
    }));
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  /** For the commands that still resolve when their work is done. */
  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const startIndexUpdate = () => {
    setError(null);
    setProgress(null);
    setSummaryCounters(null);
    setConfirmRechunk(false);
    setRunning(true);
    invoke("ai_update_book_index", { bookId }).catch((reason) => {
      setError(String(reason));
      setRunning(false);
    });
  };

  /**
   * `running` is left to the `cancelled` event rather than cleared here. The
   * stop is only honoured at the next point the phase in flight can be
   * abandoned, so clearing it now would offer the primary button back while
   * the previous run was still holding the book — and the failure the press
   * produced would be the reader's to make sense of.
   */
  const stopIndexUpdate = () => {
    setError(null);
    invoke("ai_stop_book_index", { bookId }).catch((reason) => setError(String(reason)));
  };

  const state = details ? deriveBookIndexState(details) : null;
  const outcome = runOutcome(running, progress);
  // Stop here is the library-wide switch, not a per-book one, whenever the
  // batch happens to be on this book — see IndexManagerModal's stop button
  // below for what changes because of it.
  const inLibraryBatch = runningBook(batch)?.bookId === bookId;
  const locked = busy != null || running;
  const indexedAtLabel = details?.indexedAt
    ? new Intl.DateTimeFormat(i18n.language, {
        month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(new Date(details.indexedAt))
    : null;

  const counters = progress && progress.state === "running" ? visibleCounters(progress, summaryCounters) : null;

  const verdict = (): ReactNode => {
    if (outcome === "running" && progress?.state !== "running") {
      // Kicked off, first event not in yet. Nothing to count and no phase to
      // name, so it says only what it honestly knows.
      return (
        <div className="mt-3 rounded-md bg-bg-input px-3 py-2.5">
          <p className="text-[12px] text-text-secondary">{t("indexManager.progress.starting")}</p>
          <IndeterminateBar label={t("indexManager.progress.starting")} />
        </div>
      );
    }
    if (outcome === "running" && progress) {
      const trail = phaseTrail(progress.totalSteps);
      const phaseLabel = t(`indexManager.phase.${progress.phase}`);
      return (
        <div className="mt-3 rounded-md bg-bg-input px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3 text-[12px] text-text-secondary">
            <span>{t("indexManager.progress.step", { step: progress.step, total: progress.totalSteps, phase: phaseLabel })}</span>
            {counters && <span className="tabular-nums">{counters.done} / {counters.total}</span>}
          </div>
          {counters ? (
            <div
              className="mt-2 h-[5px] overflow-hidden rounded-full bg-bg-surface"
              role="progressbar"
              aria-valuenow={counters.done}
              aria-valuemin={0}
              aria-valuemax={counters.total}
              aria-valuetext={phaseLabel}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.min(100, Math.round((counters.done / counters.total) * 100))}%` }}
              />
            </div>
          ) : (
            <IndeterminateBar label={phaseLabel} />
          )}
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-text-muted">
            {trail.map((phase, position) => {
              const step = position + 1;
              return (
                <span key={phase} className="flex items-center gap-1.5">
                  {position > 0 && <span aria-hidden className="text-text-placeholder">·</span>}
                  <span className={step === progress.step ? "font-medium text-text-primary" : step < progress.step ? "text-text-muted" : "text-text-placeholder"}>
                    {step < progress.step ? "✓ " : ""}{t(`indexManager.phase.${phase}`)}
                  </span>
                </span>
              );
            })}
          </p>
        </div>
      );
    }
    if (outcome === "failed" && progress) {
      return (
        <div className="mt-3 rounded-md bg-danger-bg px-3 py-2.5 text-[12.5px] leading-[1.65] text-danger-text">
          <p>{t("indexManager.progress.failed", { phase: t(`indexManager.phase.${progress.phase}`) })}</p>
          {progress.message && <p className="mt-1 break-words text-[11px] text-text-muted">{progress.message}</p>}
        </div>
      );
    }
    // Plain surface, not the danger one: the reader stopped it, so there is
    // nothing here to apologise for — only what to expect on the way back in.
    if (outcome === "stopped" && progress) {
      return (
        <div className="mt-3 rounded-md bg-bg-input px-3 py-2.5 text-[12.5px] leading-[1.65] text-text-secondary">
          {t("indexManager.progress.cancelled", { phase: t(`indexManager.phase.${progress.phase}`) })}
        </div>
      );
    }
    if (state === "unsupported") {
      return <div className="mt-3 rounded-md bg-bg-input px-3 py-2.5 text-[12.5px] leading-[1.65] text-text-secondary">{t("indexManager.verdict.unsupported")}</div>;
    }
    if (state === "failed") {
      return <div className="mt-3 rounded-md bg-danger-bg px-3 py-2.5 text-[12.5px] leading-[1.65] text-danger-text">{t("indexManager.verdict.failed")}</div>;
    }
    if (state === "none") {
      return <div className="mt-3 rounded-md bg-bg-input px-3 py-2.5 text-[12.5px] leading-[1.65] text-text-secondary">{t("indexManager.verdict.none")}</div>;
    }
    if (state === "building") {
      // The database says a build was under way and nothing is running now:
      // it was interrupted, and the same button resumes it.
      return <div className="mt-3 rounded-md bg-warning/10 px-3 py-2.5 text-[12.5px] leading-[1.65] text-warning">{t("indexManager.verdict.interrupted")}</div>;
    }
    if (state === "partial") {
      return (
        <div className="mt-3 rounded-md bg-warning/10 px-3 py-2.5 text-[12.5px] leading-[1.65] text-warning">
          <b className="font-semibold">{t("indexManager.verdict.partialLead")}</b>
          {t("indexManager.verdict.partialBody")}
        </div>
      );
    }
    return (
      <div className="mt-3 rounded-md bg-success/10 px-3 py-2.5 text-[12.5px] leading-[1.65] text-success-text">
        {indexedAtLabel
          ? t("indexManager.verdict.ready", { date: indexedAtLabel })
          : t("indexManager.verdict.readyNoDate")}
      </div>
    );
  };

  const showAdvanced = state != null && state !== "none" && state !== "unsupported" && !running;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className="flex max-h-[86vh] w-[min(760px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-popover">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Database size={17} className="shrink-0 text-accent-text" />
            <h3 className="truncate text-[15px] font-semibold text-text-primary">
              {bookTitle ? t("indexManager.titleWithBook", { title: bookTitle }) : t("indexManager.title")}
            </h3>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-bg-input"><X size={15} /></button>
        </header>
        <div className="flex-1 overflow-auto px-5 py-4">
          {!details || !state ? <Loader2 size={18} className="animate-spin text-text-muted" /> : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat
                  label={t("indexManager.status")}
                  value={t(`indexManager.stateLabel.${running ? "building" : state}`)}
                  tone={running ? "busy" : state === "ready" ? "good" : undefined}
                />
                <Stat
                  label={t("indexManager.card.chunks")}
                  value={details.chunkCount > 0 ? details.chunkCount : "—"}
                  tone={details.chunkCount > 0 ? "good" : undefined}
                />
                <Stat
                  label={t("indexManager.card.vectorCoverage")}
                  value={details.chunkCount > 0 ? `${details.embeddedCount} / ${details.chunkCount}` : "—"}
                  tone={state === "partial" ? "flag" : state === "ready" ? "good" : undefined}
                />
                <Stat label={t("indexManager.card.vectorModel")} value={details.embeddingModel || "—"} />
              </div>
              {verdict()}
              {running && <p className="mt-2 text-[12px] leading-[1.65] text-text-muted">{t("indexManager.progress.background")}</p>}
              {details.error && <p className="mt-3 text-[12px] text-danger-text">{details.error}</p>}

              {showAdvanced && (
                <details className="mt-3.5 border-t border-border-light pt-3">
                  <summary className="cursor-pointer text-[12.5px] text-text-secondary">{t("indexManager.advanced")}</summary>
                  <div className="mt-3 flex flex-col gap-3">
                    {confirmRechunk ? (
                      <div className="rounded-md border border-danger-border bg-danger-bg p-3">
                        <h5 className="mb-1.5 text-[12.5px] font-semibold text-danger-text">{t("indexManager.rechunk.confirmTitle")}</h5>
                        <p className="mb-1.5 text-[12px] leading-[1.7] text-text-secondary">
                          {t("indexManager.rechunk.confirmBody", { chunks: details.chunkCount, vectors: details.embeddedCount })}
                        </p>
                        <p className="mb-3 text-[11.5px] leading-[1.65] text-text-muted">{t("indexManager.rechunk.confirmNote")}</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" disabled={locked} onClick={() => setConfirmRechunk(false)}>{t("common.cancel")}</Button>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              setConfirmRechunk(false);
                              void run("rechunk", () => invoke("ai_reindex_book", { bookId }));
                            }}
                            className="h-8 rounded-md bg-danger px-2.5 text-[12.5px] font-medium text-white disabled:opacity-50"
                          >
                            {t("indexManager.rechunk.title")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-4">
                        <div className="text-[12.5px] text-text-primary">
                          {t("indexManager.rechunk.title")}
                          <p className="mt-0.5 max-w-[340px] text-[11.5px] leading-[1.55] text-text-muted">{t("indexManager.rechunk.desc")}</p>
                        </div>
                        <Button size="sm" variant="secondary" disabled={locked} onClick={() => setConfirmRechunk(true)}>
                          {busy === "rechunk" ? <Loader2 size={13} className="animate-spin" /> : null}
                          {t("indexManager.rechunk.title")}
                        </Button>
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-4">
                      <div className="text-[12.5px] text-text-primary">
                        {t("indexManager.rewriteSummaries.title")}
                        <p className="mt-0.5 max-w-[340px] text-[11.5px] leading-[1.55] text-text-muted">{t("indexManager.rewriteSummaries.desc")}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={locked}
                        onClick={() => void run("summaries", () => invoke("ai_regenerate_book_summaries", { bookId, requestId: createUuid(), overwriteEdited: false }))}
                      >
                        {busy === "summaries" ? <Loader2 size={13} className="animate-spin" /> : null}
                        {t("indexManager.rewriteSummaries.action")}
                      </Button>
                    </div>
                    {hasEditedSummary && (
                      <div className="flex items-start justify-between gap-4">
                        <div className="text-[12.5px] text-text-primary">
                          {t("indexManager.overwriteEdited")}
                          <p className="mt-0.5 max-w-[340px] text-[11.5px] leading-[1.55] text-text-muted">{t("indexManager.overwriteEditedDesc")}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={locked}
                          onClick={() => {
                            if (!window.confirm(t("indexManager.overwriteConfirm"))) return;
                            void run("overwrite", () => invoke("ai_regenerate_book_summaries", {
                              bookId,
                              requestId: createUuid(),
                              overwriteEdited: true,
                            }));
                          }}
                        >
                          {busy === "overwrite" ? <Loader2 size={13} className="animate-spin" /> : null}
                          {t("indexManager.overwriteEditedAction")}
                        </Button>
                      </div>
                    )}
                  </div>
                </details>
              )}

              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between"><h4 className="text-[13px] font-medium text-text-primary">{t("indexManager.overview")}</h4>{details.overview?.userEdited && <span className="text-[10px] text-accent-text">{t("indexManager.edited")}</span>}</div>
                <textarea value={overviewDraft} onChange={(event) => setOverviewDraft(event.target.value)} className="min-h-28 w-full resize-y rounded-md border border-border bg-bg-input p-3 text-[13px] text-text-primary outline-none focus:border-accent" />
                <Button className="mt-2" size="sm" variant="secondary" disabled={!details.overview || locked} onClick={() => void run("overview", () => invoke("update_book_overview", { bookId, content: overviewDraft }))}><Save size={13} />{t("indexManager.saveOverview")}</Button>
              </section>
              <section className="mt-5 space-y-2">
                <h4 className="text-[13px] font-medium text-text-primary">{t("indexManager.sections")}</h4>
                {details.sections.map((section) => section.sectionIndex == null ? null : (
                  <details key={section.sectionIndex} className="rounded-md border border-border p-3">
                    <summary className="cursor-pointer text-[12px] font-medium text-text-primary">{section.sectionTitle || t("indexManager.section", { index: section.sectionIndex + 1 })}{section.userEdited ? ` · ${t("indexManager.edited")}` : ""}</summary>
                    <textarea value={sectionDrafts[section.sectionIndex] ?? ""} onChange={(event) => setSectionDrafts((current) => ({ ...current, [section.sectionIndex!]: event.target.value }))} className="mt-3 min-h-24 w-full resize-y rounded-md border border-border bg-bg-input p-3 text-[12px] text-text-primary outline-none focus:border-accent" />
                    <Button className="mt-2" size="sm" variant="secondary" disabled={locked} onClick={() => void run(`section-${section.sectionIndex}`, () => invoke("update_book_section_summary", { bookId, sectionIndex: section.sectionIndex, content: sectionDrafts[section.sectionIndex!] }))}><Save size={13} />{t("indexManager.saveSection")}</Button>
                  </details>
                ))}
              </section>
              <PersonAliasesSection bookId={bookId} focusAlias={focusAlias} onLeaveForSettings={onClose} />
              <details className="mt-5"><summary className="cursor-pointer text-[13px] font-medium text-text-primary">{t("indexManager.chunkPreview")}</summary><div className="mt-2 space-y-2">{details.chunks.map((chunk) => <div key={chunk.index} className="rounded-md bg-bg-input p-3 text-[11px] leading-5 text-text-secondary"><p className="font-medium text-text-primary">{chunk.sectionTitle || `#${chunk.index + 1}`}</p>{chunk.snippet}</div>)}</div></details>
            </>
          )}
          {error && <p role="alert" className="mt-3 text-[12px] text-danger-text">{error}</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-[11.5px] text-text-muted">
            {outcome === "running" && inLibraryBatch
              ? t("indexManager.stopAffectsLibraryRun")
              : state === "ready" && !running ? t("indexManager.readyHint") : ""}
          </span>
          <div className="flex items-center gap-2">
            {/* Only while something is in flight, and outlined rather than
                filled: stopping is the smaller of the two things on offer and
                needs no weight to be found. The same shape the whole-library
                row uses, because it is the same switch underneath. */}
            {outcome === "running" && (
              <button
                type="button"
                onClick={stopIndexUpdate}
                className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-[13px] font-medium text-danger-text transition-colors hover:bg-bg-input"
              >
                {t("indexManager.stop")}
              </button>
            )}
            <Button
              variant={state === "ready" ? "secondary" : "primary"}
              size="sm"
              disabled={locked || state === "unsupported" || !details}
              onClick={startIndexUpdate}
            >
              {running && <Loader2 size={13} className="animate-spin" />}
              {state === "none" ? t("indexManager.build") : t("indexManager.fill")}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * A phase with nothing to count. It sweeps rather than sitting at 0%: a bar
 * that never moves is exactly the symptom this screen exists to remove.
 */
function IndeterminateBar({ label }: { label: string }) {
  return (
    <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-bg-surface" role="progressbar" aria-valuetext={label}>
      <div className="difficulty-scan h-full w-1/3 rounded-full bg-accent/75" />
    </div>
  );
}
