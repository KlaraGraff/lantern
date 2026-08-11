import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Activity, AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import DetailedHint from "../ui/DetailedHint";
import Input from "../ui/Input";
import Toggle from "../ui/Toggle";
import { useSettings } from "../../hooks/useSettings";
import { useContextLineProgress, resumeContextLines } from "../../hooks/useContextLineProgress";
import { CONTEXT_LINES_SETTING_KEY, contextLinesEnabled } from "./context-lines";
import { visibleCounters, type IndexProgress, type SummaryCounters } from "../index-state";
import {
  deriveLibraryIndexRow,
  failedBookIds,
  isAlreadyRunning,
  notReadyStatus,
  overallFraction,
  runningBook,
  visibleChunkCount,
  type BatchBookStatus,
  type BatchIndexProgress,
  type LibraryIndexNeeds,
} from "./library-index";

interface VectorAvailability {
  available: boolean;
  reason: string | null;
  dimensions?: number | null;
  model?: string | null;
}

interface EmbeddingProbeResult {
  ok: boolean;
  dimensions: number;
  latencyMs: number;
  error?: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The retrieval model, kept separate from the chat models it has nothing to do
 * with. The endpoint and model name are persisted by the Rust side when a probe
 * succeeds, so there is nothing to save from here.
 */
export default function EmbeddingSettings() {
  const { t } = useTranslation();
  const { settings, save: saveSetting } = useSettings();
  const [availability, setAvailability] = useState<VectorAvailability>({
    available: false,
    reason: "requires_compatible_provider",
  });
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<EmbeddingProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { progress, refresh: refreshProgress } = useContextLineProgress();
  const [resuming, setResuming] = useState(false);
  const [needs, setNeeds] = useState<LibraryIndexNeeds | null>(null);
  const [batch, setBatch] = useState<BatchIndexProgress | null>(null);
  const [bookProgress, setBookProgress] = useState<IndexProgress | null>(null);
  const [bookSummary, setBookSummary] = useState<SummaryCounters | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const contextLinesOn = contextLinesEnabled(settings);
  const contextLinesRunning = progress?.running === true;
  const contextLinesPartial = !contextLinesRunning && !!progress && progress.failed > 0;

  const refreshAvailability = useCallback(async () => {
    const next = await invoke<VectorAvailability>("ai_vector_retrieval_status");
    setAvailability(next);
  }, []);

  useEffect(() => {
    void refreshAvailability().catch(() => {
      setAvailability({ available: false, reason: "requires_compatible_provider" });
    });
  }, [refreshAvailability]);

  useEffect(() => {
    setEndpoint(settings.ai_embedding_endpoint || "http://localhost:11434/v1/embeddings");
    setModel(settings.ai_embedding_model || "text-embedding-3-small");
  }, [settings.ai_embedding_endpoint, settings.ai_embedding_model]);

  const refreshNeeds = useCallback(async () => {
    setNeeds(await invoke<LibraryIndexNeeds>("ai_books_needing_index"));
  }, []);

  const readBatchStatus = useCallback(async () => {
    setBatch((await invoke<BatchIndexProgress | null>("ai_index_all_books_status")) ?? null);
  }, []);

  // The row's own copy invites the reader to close settings and let the run
  // carry on, so on the way back in the last snapshot is the only thing that
  // knows what happened — including a run that finished an hour ago with two
  // books broken. Rendering nothing here would be the bug.
  useEffect(() => {
    void readBatchStatus().catch(() => {});
  }, [readBatchStatus]);

  // Re-read once a probe makes the model available: the count behind a
  // disabled button was taken while nothing could be indexed.
  useEffect(() => {
    void refreshNeeds().catch(() => setNeeds(null));
  }, [refreshNeeds, availability.available]);

  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    listen<BatchIndexProgress>("ai-index-all-progress", (event) => {
      if (disposed) return;
      setBatch(event.payload);
      if (event.payload.state !== "running") {
        setBookProgress(null);
        setBookSummary(null);
        void refreshNeeds().catch(() => {});
      }
    })
      .then((off) => {
        if (disposed) off();
        else stop = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refreshNeeds]);

  const activeBookId = runningBook(batch)?.bookId ?? null;

  // The inner layer. Without it a single large book leaves one book-shaped
  // step of the overall bar standing still for minutes, which is the exact
  // complaint this row exists to answer.
  useEffect(() => {
    setBookProgress(null);
    setBookSummary(null);
    if (!activeBookId) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];
    const track = (pending: Promise<UnlistenFn>) => {
      pending
        .then((off) => {
          if (disposed) off();
          else stops.push(off);
        })
        .catch(() => {});
    };
    track(
      listen<IndexProgress>(`ai-index-progress-${activeBookId}`, (event) => {
        if (!disposed) setBookProgress(event.payload);
      }),
    );
    track(
      listen<SummaryCounters>(`ai-summary-progress-${activeBookId}`, (event) => {
        if (!disposed) setBookSummary(event.payload);
      }),
    );
    return () => {
      disposed = true;
      for (const off of stops) off();
    };
  }, [activeBookId]);

  /** `undefined` means "everything that needs work"; ids mean exactly those. */
  const startBatch = async (bookIds?: string[]) => {
    setBatchBusy(true);
    setBatchError(null);
    try {
      await invoke("ai_index_all_books", { bookIds: bookIds ?? null });
    } catch (nextError) {
      setBatchError(isAlreadyRunning(nextError) ? t("settings.ai.batchAlreadyRunning") : errorText(nextError));
      // Whatever is actually running outranks what this press assumed.
      await readBatchStatus().catch(() => {});
    } finally {
      setBatchBusy(false);
    }
  };

  const stopBatch = async () => {
    setBatchError(null);
    try {
      await invoke("ai_stop_index_all_books");
    } catch (nextError) {
      setBatchError(errorText(nextError));
    }
  };

  const toggleVectorRetrieval = async (enabled: boolean) => {
    setError(null);
    try {
      await invoke("set_ai_vector_retrieval", { enabled });
      await saveSetting("ai_vector_retrieval", enabled ? "true" : "false");
      await refreshAvailability();
    } catch (nextError) {
      setError(errorText(nextError));
      await refreshAvailability().catch(() => {});
    }
  };

  const toggleContextLines = async (enabled: boolean) => {
    setError(null);
    try {
      await saveSetting(CONTEXT_LINES_SETTING_KEY, enabled ? "true" : "false");
    } catch (nextError) {
      setError(errorText(nextError));
    }
  };

  const resume = async () => {
    if (!progress) return;
    setResuming(true);
    try {
      await resumeContextLines(progress.book_id);
      await refreshProgress();
    } finally {
      setResuming(false);
    }
  };

  const testEmbedding = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await invoke<EmbeddingProbeResult>("ai_embedding_probe", {
        endpoint,
        model,
        apiKey: apiKey || null,
      });
      setProbe(result);
      if (result.ok) {
        // Never keep the key in component state once it has been accepted.
        setApiKey("");
        await refreshAvailability();
      }
    } catch (nextError) {
      setProbe(null);
      setError(errorText(nextError));
    } finally {
      setTesting(false);
    }
  };

  const row = deriveLibraryIndexRow({ available: availability.available, needs, batch });
  const innerCounters =
    bookProgress?.state === "running" ? visibleCounters(bookProgress, bookSummary) : null;
  const fraction = row.kind === "running" ? overallFraction(row, innerCounters) : null;
  const batchBooks = row.kind === "running" || row.kind === "finished" ? row.books : null;

  const batchHint = () => {
    switch (row.kind) {
      case "unavailable":
        return t("settings.ai.batchUnavailable");
      case "idle":
        return row.pending > 0 ? t("settings.ai.batchIdle") : t("settings.ai.batchAllReady");
      case "running":
        return row.current > 0
          ? t("settings.ai.batchRunning", { current: row.current, total: row.total })
          : t("settings.ai.batchStarting");
      case "finished":
        return t(row.cancelled ? "settings.ai.batchStopped" : "settings.ai.batchFinished", {
          done: row.done,
          failed: row.failed,
        });
    }
  };

  const batchAction = () => {
    if (row.kind === "running") {
      // Outlined rather than filled: stopping is the smaller of the two things
      // on offer here, and near-instant, so it needs no weight to be found.
      return (
        <button
          type="button"
          onClick={() => void stopBatch()}
          className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium text-danger-text transition-colors hover:bg-bg-input touch:h-11"
        >
          {t("settings.ai.batchStop")}
        </button>
      );
    }
    if (row.kind === "finished") {
      return (
        <Button size="sm" onClick={() => void startBatch(failedBookIds(batch))} disabled={batchBusy}>
          {batchBusy && <Loader2 size={13} className="animate-spin" />}
          {t("settings.ai.batchRetry")}
        </Button>
      );
    }
    if (row.kind === "idle" && row.pending > 0) {
      return (
        <Button size="sm" onClick={() => void startBatch()} disabled={batchBusy}>
          {batchBusy && <Loader2 size={13} className="animate-spin" />}
          {t("settings.ai.batchBuildCount", { count: row.pending })}
        </Button>
      );
    }
    return (
      <Button size="sm" variant="secondary" disabled>
        {t("settings.ai.batchBuild")}
      </Button>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6 pt-2">
      <div className="mb-4 border-b border-border pb-4">
        <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.embeddingTitle")}</h4>
        <DetailedHint
          className="mt-0.5"
          hint={t("settings.ai.embeddingHint")}
          detail={t("settings.ai.embeddingDetail")}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="http://localhost:11434/v1/embeddings"
          />
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="text-embedding-3-small"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("settings.ai.embeddingKeyPlaceholder")}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void testEmbedding()}
            disabled={testing || !endpoint.trim() || !model.trim()}
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
            {t("settings.ai.embeddingTest")}
          </Button>
        </div>
        {(probe || availability.available) && (
          <p className={`mt-2 text-[11px] ${probe?.ok === false ? "text-danger-text" : "text-success-text"}`}>
            {probe?.ok === false
              ? t("settings.ai.embeddingFailed")
              : t("settings.ai.embeddingAvailable", {
                  dimensions: probe?.dimensions ?? availability.dimensions,
                  latency: probe?.latencyMs ?? "-",
                })}
          </p>
        )}
      </div>

      <div className="flex min-h-[73px] items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.vectorRetrieval")}</h4>
          <DetailedHint
            className="mt-0.5"
            hint={
              availability.available
                ? t("settings.ai.vectorRetrievalHint")
                : t("settings.ai.vectorRetrievalUnavailable")
            }
            detail={t("settings.ai.vectorRetrievalDetail")}
          />
        </div>
        <Toggle
          checked={settings.ai_vector_retrieval === "true"}
          onChange={(enabled) => void toggleVectorRetrieval(enabled)}
          disabled={!availability.available}
          label={t("settings.ai.vectorRetrieval")}
        />
      </div>

      {/* A peer of the vector-retrieval row, not a sub-row of it. It was
          indented under it while the identity sentence only ever prefixed
          what went to the embedding model; it now also feeds the full-text
          index, which works with no embedding provider configured at all. */}
      <div className="flex min-h-[73px] items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.contextLines")}</h4>
          <DetailedHint
            className="mt-0.5"
            hint={t("settings.ai.contextLinesHint")}
            detail={t("settings.ai.contextLinesDetail")}
          />
          {contextLinesRunning && progress && (
            <>
              <p className="mt-1.5 text-[11px] text-text-muted">
                {t("settings.ai.contextLinesRunning", { book: progress.book_title })}
              </p>
              <div className="mt-1.5 flex max-w-[210px] items-center gap-2">
                <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-border">
                  {progress.total > 0 ? (
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
                    />
                  ) : (
                    <div className="difficulty-scan h-full w-1/3 rounded-full bg-accent/75" />
                  )}
                </div>
                {progress.total > 0 && (
                  <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                    {t("settings.ai.contextLinesProgress", { done: progress.done, total: progress.total })}
                  </span>
                )}
              </div>
            </>
          )}
          {contextLinesPartial && progress && (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-bg-muted px-2.5 py-2">
              <p className="min-w-0 flex-1 text-[11px] leading-[1.55] text-text-secondary">
                {t("settings.ai.contextLinesPartial", { book: progress.book_title, count: progress.failed })}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => void resume()}
                disabled={resuming}
              >
                {resuming && <Loader2 size={12} className="animate-spin" />}
                {t("settings.ai.contextLinesResume")}
              </Button>
            </div>
          )}
        </div>
        <Toggle
          checked={contextLinesOn}
          onChange={(enabled) => void toggleContextLines(enabled)}
          label={t("settings.ai.contextLines")}
        />
      </div>

      {/* The whole library at once, last on the page: everything above it is
          what a run needs configured, and this is the one control that spends
          the model. */}
      <div className="border-b border-border py-3">
        <div className="flex min-h-[67px] items-center justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.batchTitle")}</h4>
            <p className="mt-0.5 max-w-[400px] text-[12px] leading-[1.55] text-text-muted">{batchHint()}</p>
          </div>
          {batchAction()}
        </div>

        {row.kind === "running" && (
          <div
            className="mt-1 h-[5px] overflow-hidden rounded-full bg-bg-input"
            role="progressbar"
            aria-valuetext={t("settings.ai.batchProgress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fraction != null ? Math.round(fraction * 100) : undefined}
          >
            {fraction != null ? (
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            ) : (
              <div className="difficulty-scan h-full w-1/3 rounded-full bg-accent/75" />
            )}
          </div>
        )}

        {batchBooks && batchBooks.length > 0 && (
          <ul aria-label={t("settings.ai.batchBookList")} className="mt-3 rounded-md border border-border">
            {batchBooks.map((book) => (
              <BatchBookRow
                key={book.bookId}
                book={book}
                phase={book.state === "running" ? bookProgress : null}
                counters={book.state === "running" ? innerCounters : null}
              />
            ))}
          </ul>
        )}

        {batchError && <p className="mt-2 text-[11px] text-danger-text">{batchError}</p>}
      </div>

      {error && <p className="mt-3 text-[11px] text-danger-text">{error}</p>}
    </div>
  );
}

const NOT_READY_KEYS: Record<string, string> = {
  missing: "settings.ai.batchBookNotReady.missing",
  unsupported: "settings.ai.batchBookNotReady.unsupported",
  building: "settings.ai.batchBookNotReady.building",
  failed: "settings.ai.batchBookNotReady.failed",
};

/**
 * One book in the batch. A failure is shown in the reader's own words; the
 * provider's string is kept on the title attribute, where it can be read
 * without being the thing the row says.
 */
function BatchBookRow({
  book,
  phase,
  counters,
}: {
  book: BatchBookStatus;
  phase: IndexProgress | null;
  counters: { done: number; total: number } | null;
}) {
  const { t } = useTranslation();
  const notReady = notReadyStatus(book.message);
  const failureText = notReady && NOT_READY_KEYS[notReady] ? t(NOT_READY_KEYS[notReady]) : t("settings.ai.batchBookFailed");
  const phaseLabel = phase ? t(`indexManager.phase.${phase.phase}`) : null;

  const status = () => {
    switch (book.state) {
      case "done":
        return { text: t("settings.ai.batchBookDone"), tone: "text-success-text" };
      case "failed":
        return { text: failureText, tone: "text-danger-text" };
      case "running":
        return {
          text:
            phaseLabel && counters
              ? t("settings.ai.batchBookProgress", { phase: phaseLabel, done: counters.done, total: counters.total })
              : (phaseLabel ?? t("settings.ai.batchBookRunning")),
          tone: "text-accent-text",
        };
      default:
        return { text: t("settings.ai.batchBookPending"), tone: "text-text-muted" };
    }
  };

  const { text, tone } = status();
  const chunks = visibleChunkCount(book);

  return (
    <li className="flex items-center gap-2.5 border-b border-border-light px-3 py-2.5 text-[12.5px] last:border-b-0">
      <span className="flex w-4 shrink-0 justify-center">
        {book.state === "done" && <Check size={13} className="text-success-text" />}
        {book.state === "failed" && <AlertCircle size={13} className="text-danger-text" />}
        {book.state === "running" && <Loader2 size={13} className="animate-spin text-accent-text" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{book.title}</span>
      {/* Muted and to the left of a fixed-width verdict, so the counts line up
          down the column and can be compared at a glance without any of them
          competing with the verdict itself. A book that came back with twelve
          chunks next to neighbours in the thousands is the one thing this
          number exists to make visible. */}
      {chunks != null && (
        <span className="shrink-0 text-[11.5px] tabular-nums text-text-muted">
          {t("settings.ai.batchBookChunks", { count: chunks })}
        </span>
      )}
      <span className={`shrink-0 text-[11.5px] tabular-nums ${tone}`} title={book.state === "failed" ? book.message : undefined}>
        {text}
      </span>
    </li>
  );
}
