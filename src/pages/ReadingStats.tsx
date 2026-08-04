import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, CalendarDays, LockKeyhole, RefreshCw, Sparkles, X } from "lucide-react";
import type {
  CachedReadingReview,
  ReadingReviewErrorCode,
  ReadingReviewProvider,
  ReadingStatsAdapter,
  ReadingStatsBook,
  ReadingStatsCalendarDay,
  ReadingStatsDashboard,
  ReadingStatsLabels,
  ReadingStatsQuery,
  ReadingStatsRange,
  ReadingStatsView,
} from "./reading-stats/types";
import { ReadingReviewError } from "./reading-stats/types";

export interface ReadingStatsProps {
  adapter: ReadingStatsAdapter;
  labels: ReadingStatsLabels;
  provider: ReadingReviewProvider;
  aiReviewDisclosureAcknowledged: boolean;
  onAcknowledgeAiReviewDisclosure(): Promise<void> | void;
  onOpenBook?(bookId: string): void;
}

function reviewErrorCode(error: unknown): ReadingReviewErrorCode {
  if (error instanceof ReadingReviewError) return error.code;
  if (typeof error === "object" && error && "code" in error) {
    const code = String(error.code);
    if (code === "notConfigured" || code === "quotaExceeded" || code === "offline") return code;
  }
  return "failed";
}

function ReviewPanel({
  review,
  provider,
  labels,
  generating,
  error,
  onGenerate,
}: {
  review: CachedReadingReview | null;
  provider: ReadingReviewProvider;
  labels: ReadingStatsLabels;
  generating: boolean;
  error: ReadingReviewErrorCode | null;
  onGenerate(): void;
}) {
  const errorText = error === "notConfigured"
    ? labels.aiNotConfigured
    : error === "quotaExceeded"
      ? labels.aiQuotaExceeded
      : error === "offline"
        ? labels.aiOffline
        : error
          ? labels.aiFailed
          : null;

  return (
    <section className="rounded-xl border border-border bg-bg-surface p-5" aria-labelledby="reading-review-heading">
      <div className="flex items-start justify-between gap-5">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-accent" aria-hidden="true" />
            <h2 id="reading-review-heading" className="text-[13px] font-semibold text-text-primary">
              {labels.aiReviewHeading}
            </h2>
            <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] font-semibold text-accent-text">
              {labels.aiBadge}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-text-muted">{labels.aiReviewDescription}</p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11px] font-medium text-white disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw size={13} className={generating ? "animate-spin" : ""} aria-hidden="true" />
          {generating ? labels.aiGenerating : review ? labels.aiRefresh : labels.aiGenerate}
        </button>
      </div>

      {review ? (
        <div className="mt-4 rounded-lg bg-bg-input px-4 py-3">
          <p className="whitespace-pre-wrap font-serif text-[15px] leading-7 text-text-secondary">{review.narrative}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-muted">
            <span>{labels.aiGeneratedBy}</span>
            <span>{review.providerName}</span>
            <span aria-hidden="true">·</span>
            <span>{review.model}</span>
            <span aria-hidden="true">·</span>
            <span>{labels.formatReviewUpdatedAt(review.updatedAt)}</span>
          </div>
        </div>
      ) : null}

      {errorText ? (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5 text-[11px] text-danger-text">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{errorText}</span>
          {review ? <span className="ml-auto shrink-0 text-text-muted">{labels.aiCachedNotice}</span> : null}
        </div>
      ) : null}

      {!provider.configured && !errorText ? (
        <p className="mt-3 text-[10px] text-text-muted">{labels.aiNotConfigured}</p>
      ) : null}
    </section>
  );
}

function BookHistory({
  books,
  labels,
  onOpenBook,
}: {
  books: ReadingStatsBook[];
  labels: ReadingStatsLabels;
  onOpenBook?: (bookId: string) => void;
}) {
  const largest = Math.max(1, ...books.map((book) => book.activeSeconds));
  return (
    <section aria-labelledby="reading-history-heading">
      <div className="mb-3">
        <h2 id="reading-history-heading" className="text-[13px] font-semibold text-text-primary">{labels.historyHeading}</h2>
        <p className="mt-1 text-[10px] text-text-muted">{labels.historyDescription}</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-bg-surface">
        {books.map((book) => (
          <button
            key={book.bookId}
            type="button"
            onClick={() => onOpenBook?.(book.bookId)}
            disabled={!onOpenBook}
            className="grid w-full grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-bg-muted disabled:cursor-default"
          >
            <span className="flex h-14 w-[42px] items-center justify-center overflow-hidden rounded bg-bg-input text-text-muted shadow-sm">
              {book.coverData ? <img src={book.coverData} alt="" className="h-full w-full object-cover" /> : <BookOpen size={17} aria-hidden="true" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-text-primary">{book.title}</span>
              {book.author ? <span className="mt-0.5 block truncate text-[10px] text-text-muted">{book.author}</span> : null}
              <span className="mt-2 block h-1 overflow-hidden rounded-full bg-bg-input">
                <span
                  className="block h-full rounded-full bg-accent/65"
                  style={{ width: `${Math.max(3, Math.round((book.activeSeconds / largest) * 100))}%` }}
                />
              </span>
              <span className="mt-1 block text-[9px] text-text-muted">
                {labels.progressLabel} {Math.round(Math.max(0, Math.min(1, book.progress)) * 100)}%
              </span>
            </span>
            <span className="text-right">
              <span className="block font-serif text-[15px] text-text-primary">{labels.formatDuration(book.activeSeconds)}</span>
              <span className="mt-1 block text-[9px] text-text-muted">{labels.sessionCountLabel(book.sessionCount)}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ReadingCalendar({ days, labels }: { days: ReadingStatsCalendarDay[]; labels: ReadingStatsLabels }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = days.find((day) => day.date === selectedDate) ?? null;
  const maximum = Math.max(1, ...days.map((day) => day.activeSeconds));

  return (
    <section aria-labelledby="reading-calendar-heading">
      <div className="mb-3">
        <h2 id="reading-calendar-heading" className="text-[13px] font-semibold text-text-primary">{labels.calendarHeading}</h2>
        <p className="mt-1 text-[10px] text-text-muted">{labels.calendarDescription}</p>
      </div>
      <div className="rounded-xl border border-border bg-bg-surface p-5">
        {days.length ? (
          <div
            className="grid w-full gap-1.5 overflow-x-auto pb-1"
            style={{ gridTemplateRows: "repeat(7, 13px)", gridAutoFlow: "column", gridAutoColumns: "13px" }}
          >
            {days.map((day) => {
              const ratio = day.activeSeconds / maximum;
              const opacity = day.activeSeconds === 0 ? 0.08 : 0.2 + ratio * 0.8;
              return (
                <button
                  key={day.date}
                  type="button"
                  aria-label={`${labels.formatDate(day.date)} · ${labels.formatDuration(day.activeSeconds)}`}
                  aria-pressed={selectedDate === day.date}
                  title={`${labels.formatDate(day.date)} · ${labels.formatDuration(day.activeSeconds)}`}
                  onClick={() => setSelectedDate(day.date)}
                  className="h-[13px] w-[13px] rounded-[3px] bg-accent outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                  style={{ opacity }}
                />
              );
            })}
          </div>
        ) : (
          <div className="py-16 text-center">
            <CalendarDays size={25} className="mx-auto text-text-muted" aria-hidden="true" />
            <p className="mt-3 text-[12px] font-medium text-text-primary">{labels.noCalendarActivity}</p>
            <p className="mt-1 text-[10px] text-text-muted">{labels.noCalendarActivityDescription}</p>
          </div>
        )}

        {selected ? (
          <div className="mt-4 rounded-lg bg-bg-input px-4 py-3" aria-live="polite">
            <div className="flex items-baseline justify-between gap-3">
              <strong className="text-[12px] text-text-primary">{labels.formatDate(selected.date)}</strong>
              <span className="font-serif text-[15px] text-accent-text">{labels.formatDuration(selected.activeSeconds)}</span>
            </div>
            <ul className="mt-2 divide-y divide-border">
              {selected.sessions.map((session, index) => (
                <li key={`${session.bookId}-${session.startedAt}-${index}`} className="flex items-center justify-between gap-3 py-2 text-[10px]">
                  <span className="truncate text-text-secondary">{session.title}</span>
                  <span className="shrink-0 text-text-muted">
                    {labels.formatTime(session.startedAt)}–{labels.formatTime(session.endedAt)} · {labels.formatDuration(session.activeSeconds)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay p-6" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="reading-stats-modal-title" className="w-full max-w-md rounded-xl bg-bg-surface p-5 shadow-popover">
        <div className="flex items-center justify-between gap-4">
          <h2 id="reading-stats-modal-title" className="text-[15px] font-semibold text-text-primary">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-text-muted hover:bg-bg-input">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default function ReadingStats({
  adapter,
  labels,
  provider,
  aiReviewDisclosureAcknowledged,
  onAcknowledgeAiReviewDisclosure,
  onOpenBook,
}: ReadingStatsProps) {
  const [view, setView] = useState<ReadingStatsView>("history");
  const [range, setRange] = useState<ReadingStatsRange>("year");
  const [bookId, setBookId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<ReadingStatsDashboard | null>(null);
  const [knownBooks, setKnownBooks] = useState<ReadingStatsBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [reviewError, setReviewError] = useState<ReadingReviewErrorCode | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [acknowledgedLocally, setAcknowledgedLocally] = useState(aiReviewDisclosureAcknowledged);
  const loadGeneration = useRef(0);
  const query = useMemo<ReadingStatsQuery>(() => ({ range, bookId }), [range, bookId]);

  useEffect(() => {
    setAcknowledgedLocally(aiReviewDisclosureAcknowledged);
  }, [aiReviewDisclosureAcknowledged]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(false);
    adapter.loadDashboard(query).then((next) => {
      if (generation !== loadGeneration.current) return;
      setDashboard(next);
      setKnownBooks((current) => {
        const merged = new Map(current.map((book) => [book.bookId, book]));
        for (const book of next.books) merged.set(book.bookId, book);
        return [...merged.values()];
      });
    }).catch(() => {
      if (generation === loadGeneration.current) setLoadError(true);
    }).finally(() => {
      if (generation === loadGeneration.current) setLoading(false);
    });
  }, [adapter, query, reloadKey]);

  const generateReview = useCallback(async () => {
    if (!provider.configured) {
      setReviewError("notConfigured");
      return;
    }
    setGenerating(true);
    setReviewError(null);
    try {
      const review = await adapter.generateReview(query);
      setDashboard((current) => current ? { ...current, cachedReview: review } : current);
    } catch (error) {
      setReviewError(reviewErrorCode(error));
    } finally {
      setGenerating(false);
    }
  }, [adapter, provider.configured, query]);

  const requestGenerate = useCallback(() => {
    if (!acknowledgedLocally) setDisclosureOpen(true);
    else void generateReview();
  }, [acknowledgedLocally, generateReview]);

  const confirmDisclosure = useCallback(async () => {
    await onAcknowledgeAiReviewDisclosure();
    setAcknowledgedLocally(true);
    setDisclosureOpen(false);
    await generateReview();
  }, [generateReview, onAcknowledgeAiReviewDisclosure]);

  if (loading && !dashboard) {
    return <div className="grid h-full place-items-center bg-bg-surface text-[12px] text-text-muted" role="status">{labels.loading}</div>;
  }

  if (loadError && !dashboard) {
    return (
      <div className="grid h-full place-items-center bg-bg-surface">
        <div className="text-center" role="alert">
          <AlertCircle size={24} className="mx-auto text-danger-text" aria-hidden="true" />
          <p className="mt-3 text-[12px] text-text-secondary">{labels.loadFailed}</p>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="mt-3 h-8 rounded-lg bg-accent px-3 text-[11px] text-white">{labels.retry}</button>
        </div>
      </div>
    );
  }

  if (!dashboard || dashboard.overview.sessionCount === 0) {
    return (
      <div className="grid h-full place-items-center bg-bg-surface px-6 text-center">
        <div className="max-w-md">
          <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent-bg text-accent"><BookOpen size={27} aria-hidden="true" /></span>
          <h1 className="mt-5 font-serif text-[21px] font-semibold text-text-primary">{labels.emptyTitle}</h1>
          <p className="mt-2 text-[11px] leading-6 text-text-muted">{labels.emptyDescription}</p>
          <p className="mt-5 border-t border-border pt-4 text-[10px] leading-5 text-text-muted">{labels.emptyRule}</p>
        </div>
      </div>
    );
  }

  const metrics = [
    [labels.formatDuration(dashboard.overview.totalActiveSeconds), labels.focusedReading],
    [String(dashboard.overview.booksTouched), labels.booksRead],
    [String(dashboard.overview.completedBooks), labels.booksCompleted],
    [String(dashboard.overview.sessionCount), labels.validSessions],
  ];

  return (
    <main className="h-full overflow-y-auto bg-bg-surface text-text-primary">
      <header className="sticky top-0 z-20 flex min-h-[104px] items-end justify-between gap-6 border-b border-border bg-bg-surface/95 px-8 pb-4 pt-titlebar backdrop-blur">
        <div>
          <h1 className="text-[23px] font-semibold">{labels.title}</h1>
          <p className="mt-1 text-[11px] text-text-muted">{view === "history" ? labels.subtitleHistory : labels.subtitleCalendar}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select value={bookId ?? ""} onChange={(event) => setBookId(event.target.value || null)} className="h-8 rounded-lg border border-border bg-bg-surface px-2.5 text-[11px] text-text-secondary">
            <option value="">{labels.allBooks}</option>
            {knownBooks.map((book) => <option key={book.bookId} value={book.bookId}>{book.title}</option>)}
          </select>
          <div className="flex rounded-lg border border-border bg-bg-input p-0.5" role="group">
            {(["last30Days", "year", "all"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)} className={`h-7 rounded-md px-2.5 text-[10px] ${range === value ? "bg-bg-surface font-medium text-text-primary shadow-sm" : "text-text-muted"}`}>
                {value === "last30Days" ? labels.last30Days : value === "year" ? labels.thisYear : labels.allTime}
              </button>
            ))}
          </div>
          <button type="button" aria-label={labels.privacyButton} onClick={() => setPrivacyOpen(true)} className="grid size-8 place-items-center rounded-lg border border-border text-text-muted hover:bg-bg-input">
            <LockKeyhole size={14} aria-hidden="true" />
          </button>
          <div className="flex rounded-lg border border-accent/25 bg-accent-bg p-0.5" role="group">
            {(["history", "calendar"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`h-7 rounded-md px-2.5 text-[10px] ${view === value ? "bg-bg-surface font-medium text-accent-text shadow-sm" : "text-text-muted"}`}>
                {value === "history" ? labels.historyView : labels.calendarView}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1040px] space-y-6 px-7 py-7">
        <section className="grid grid-cols-4 border-y border-border py-4">
          {metrics.map(([value, label], index) => (
            <div key={label} className={`px-5 ${index ? "border-l border-border" : "pl-0"}`}>
              <strong className="block font-serif text-[24px] font-medium">{value}</strong>
              <span className="mt-1 block text-[10px] text-text-muted">{label}</span>
            </div>
          ))}
        </section>

        <ReviewPanel review={dashboard.cachedReview} provider={provider} labels={labels} generating={generating} error={reviewError} onGenerate={requestGenerate} />

        {view === "history"
          ? <BookHistory books={dashboard.books} labels={labels} onOpenBook={onOpenBook} />
          : <ReadingCalendar days={dashboard.calendar} labels={labels} />}

        {loadError ? (
          <div role="status" className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-[10px] text-danger-text">
            <AlertCircle size={13} aria-hidden="true" />{labels.loadFailed}
            <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="ml-auto underline">{labels.retry}</button>
          </div>
        ) : null}
      </div>

      {privacyOpen ? (
        <Modal title={labels.privacyTitle} onClose={() => setPrivacyOpen(false)}>
          <p className="mt-2 text-[11px] leading-5 text-text-muted">{labels.privacyDescription}</p>
          <ul className="mt-4 divide-y divide-border text-[11px] leading-5 text-text-secondary">
            {[labels.privacyLocalFacts, labels.privacyAiScope, labels.privacyNoSocial, labels.privacySessionRule].map((item) => (
              <li key={item} className="py-3">{item}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setPrivacyOpen(false)} className="mt-4 h-8 w-full rounded-lg bg-accent text-[11px] font-medium text-white">{labels.close}</button>
        </Modal>
      ) : null}

      {disclosureOpen ? (
        <Modal title={labels.aiDisclosureTitle} onClose={() => setDisclosureOpen(false)}>
          <p className="mt-2 text-[11px] leading-5 text-text-muted">{labels.aiDisclosureDescription}</p>
          <dl className="mt-4 space-y-3 rounded-lg bg-bg-input p-4 text-[10px] leading-5">
            <div><dt className="font-semibold text-text-primary">{labels.aiDisclosureProvider}</dt><dd className="text-text-muted">{provider.name} · {provider.model}</dd></div>
            <div><dt className="font-semibold text-text-primary">{labels.aiDisclosureData}</dt><dd className="text-text-muted">{labels.aiDisclosureDataValue}</dd></div>
            <div><dt className="font-semibold text-text-primary">{labels.aiDisclosureExcludes}</dt><dd className="text-text-muted">{labels.aiDisclosureExcludesValue}</dd></div>
            <div><dt className="font-semibold text-text-primary">{labels.aiDisclosureBilling}</dt><dd className="text-text-muted">{provider.billingNotice}</dd></div>
          </dl>
          <button type="button" onClick={() => void confirmDisclosure()} className="mt-4 h-8 w-full rounded-lg bg-accent text-[11px] font-medium text-white">{labels.aiDisclosureConfirm}</button>
        </Modal>
      ) : null}
    </main>
  );
}
