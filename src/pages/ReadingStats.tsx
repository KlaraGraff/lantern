import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, BookOpen, CalendarDays, LockKeyhole, RefreshCw, Sparkles, X } from "lucide-react";
import type {
  AutoReviewOffer,
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
  VocabLearningStats,
  VocabMasteryDistribution,
} from "./reading-stats/types";
import { ReadingReviewError } from "./reading-stats/types";
import type { LevelObservation } from "./reading-stats/level-observation";
import { splitEmphasis } from "../i18n/emphasis";

export interface ReadingStatsProps {
  adapter: ReadingStatsAdapter;
  labels: ReadingStatsLabels;
  provider: ReadingReviewProvider;
  aiReviewDisclosureAcknowledged: boolean;
  onAcknowledgeAiReviewDisclosure(): Promise<void> | void;
  onOpenBook?(bookId: string): void;
  /** Where the level actually lives. This page only ever points at it. */
  onOpenLevelSettings?(): void;
  /** The "去复习 →" link on the learning view's due-for-review metric. Points
   * at the same review entry point the sidebar's own "Review" row opens. */
  onOpenReview?(): void;
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
  pendingReason,
  provider,
  labels,
  generating,
  error,
  onGenerate,
  autoOffer,
  onAcceptAuto,
  onDeclineAuto,
}: {
  review: CachedReadingReview | null;
  /**
   * Set only when the page is scoped to one book and that book's automatic
   * review attempt failed. Persisted server-side, so it is already here on
   * the very first render — the reader never has to press "generate" once
   * just to discover a summary was owed.
   */
  pendingReason: ReadingReviewErrorCode | null;
  provider: ReadingReviewProvider;
  labels: ReadingStatsLabels;
  generating: boolean;
  error: ReadingReviewErrorCode | null;
  onGenerate(): void;
  autoOffer: AutoReviewOffer | null;
  onAcceptAuto(): void;
  onDeclineAuto(): void;
}) {
  const reasonText = (code: ReadingReviewErrorCode) => code === "notConfigured"
    ? labels.aiNotConfigured
    : code === "quotaExceeded"
      ? labels.aiQuotaExceeded
      : code === "offline"
        ? labels.aiOffline
        : labels.aiFailed;
  const errorText = error ? reasonText(error) : null;
  // The persisted placeholder only has something to say while there is
  // nothing more current already on screen: a review that arrived since, or
  // a live error from a just-pressed retry (same information, fresher).
  const showPending = !review && !error && !generating && pendingReason !== null;

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
          {generating ? labels.aiGenerating : review || pendingReason ? labels.aiRefresh : labels.aiGenerate}
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

      {/* Static, not a notification: nothing here is a dialog, a badge, or a
          dot. It sits exactly where the review itself would sit, and it
          stays until a generation succeeds — it does not need to be
          re-discovered on a later visit. */}
      {showPending ? (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-bg-input px-4 py-3">
          <p className="text-[11.5px] font-medium text-text-primary">{labels.aiPendingTitle}</p>
          <p className="mt-1 text-[11px] leading-5 text-text-muted">{reasonText(pendingReason)}</p>
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

      {/* Never a dialog and never a nag. The offer appears in the place the
          reader has just finished using the thing it is about, and one
          refusal retires it for good. */}
      {autoOffer?.recommend ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-accent-bg bg-accent-bg px-3.5 py-3">
          <div className="min-w-0 flex-1 text-[11px] leading-[1.55] text-text-secondary">
            <b className="mb-0.5 block text-[11.5px] font-semibold text-accent-text">
              {labels.autoOfferTitle(autoOffer.manualRuns)}
            </b>
            {autoOffer.typicalTokens === null
              ? labels.autoOfferBody
              : labels.autoOfferBodyWithCost(autoOffer.typicalTokens)}
          </div>
          <button
            type="button"
            onClick={onDeclineAuto}
            className="shrink-0 rounded px-1.5 py-1 text-[11px] text-text-muted hover:text-text-primary"
          >
            {labels.autoOfferDecline}
          </button>
          <button
            type="button"
            onClick={onAcceptAuto}
            className="inline-flex h-7 shrink-0 items-center rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white"
          >
            {labels.autoOfferAccept}
          </button>
        </div>
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
  // Replaces the native `title` attribute, whose hover delay is a fixed OS
  // setting (~1s) no CSS or JS can shorten. `left`/`top` are pre-computed
  // against `containerRef` (not the grid's own scrolling box) at the moment
  // the dot is hovered, so the tooltip is never clipped by the grid's
  // horizontal scrollbar.
  const [hover, setHover] = useState<{ date: string; left: number; top: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = days.find((day) => day.date === selectedDate) ?? null;
  const maximum = Math.max(1, ...days.map((day) => day.activeSeconds));

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const scheduleHover = (date: string, target: HTMLElement) => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const dotRect = target.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setHover({
        date,
        left: dotRect.left - containerRect.left + dotRect.width / 2,
        top: dotRect.top - containerRect.top,
      });
    }, 150);
  };

  const hideHover = () => {
    clearHoverTimer();
    setHover(null);
  };

  useEffect(() => clearHoverTimer, []);

  const hoveredDay = hover ? days.find((day) => day.date === hover.date) ?? null : null;

  return (
    <section aria-labelledby="reading-calendar-heading">
      <div className="mb-3">
        <h2 id="reading-calendar-heading" className="text-[13px] font-semibold text-text-primary">{labels.calendarHeading}</h2>
        <p className="mt-1 text-[10px] text-text-muted">{labels.calendarDescription}</p>
      </div>
      <div ref={containerRef} className="relative rounded-xl border border-border bg-bg-surface p-5">
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
                  onClick={() => setSelectedDate(day.date)}
                  onMouseEnter={(event) => scheduleHover(day.date, event.currentTarget)}
                  onMouseLeave={hideHover}
                  onFocus={(event) => scheduleHover(day.date, event.currentTarget)}
                  onBlur={hideHover}
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

        {hoveredDay ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-[#18181B]/90 px-2.5 py-1.5 text-[11px] leading-4 text-white shadow-popover"
            style={{ left: hover!.left, top: hover!.top - 6 }}
          >
            {`${labels.formatDate(hoveredDay.date)} · ${labels.formatDuration(hoveredDay.activeSeconds)}`}
          </div>
        ) : null}

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

/**
 * The daily/weekly/monthly bar chart on the learning view. Every bar carries
 * a native `title` tooltip (date + count) rather than the mockup's bespoke
 * hover popup — same information, and it is the same hover convention
 * `ReadingCalendar`'s own day cells already use just above on this page. The
 * peak bar's count is drawn permanently above it; every other bar stays bare
 * until hovered, per the mockup's "selective, not general" labeling.
 */
function LearningTrendChart({
  trend,
  granularity,
  labels,
}: {
  trend: VocabLearningStats["trend"];
  granularity: VocabLearningStats["trendGranularity"];
  labels: ReadingStatsLabels;
}) {
  const peak = Math.max(0, ...trend.map((bucket) => bucket.count));
  const scale = Math.max(1, peak);
  const first = trend[0];
  const last = trend[trend.length - 1];
  const middle = trend[Math.floor((trend.length - 1) / 2)];
  const axisDates = [first, middle, last].filter(
    (bucket, index, all) => bucket && all.findIndex((other) => other?.date === bucket.date) === index,
  );

  return (
    <div>
      <h3 className="text-[11.5px] font-semibold text-text-primary">{labels.learningTrendTitle}</h3>
      <p className="mt-0.5 text-[10px] text-text-muted">{labels.learningTrendDescription(granularity)}</p>
      <div className="mt-2.5 flex h-24 items-end gap-0.5 border-b border-border">
        {trend.map((bucket) => {
          const isPeak = peak > 0 && bucket.count === peak;
          const heightPx = Math.max(2, Math.round((bucket.count / scale) * 84));
          return (
            <div
              key={bucket.date}
              className="relative max-w-[14px] flex-1"
              style={{ height: `${heightPx}px` }}
              title={labels.learningTrendTooltip(labels.formatDate(bucket.date), bucket.count)}
            >
              {isPeak ? (
                <span className="pointer-events-none absolute inset-x-0 -top-3.5 text-center text-[9px] font-semibold text-text-secondary">
                  {bucket.count}
                </span>
              ) : null}
              <div
                className={
                  bucket.count === 0
                    ? "h-full rounded-sm bg-border"
                    : "h-full rounded-t bg-accent opacity-85 hover:opacity-100"
                }
              />
            </div>
          );
        })}
      </div>
      {axisDates.length ? (
        <div className="mt-1.5 flex justify-between text-[9px] text-text-muted">
          {axisDates.map((bucket) => <span key={bucket!.date}>{labels.formatDate(bucket!.date)}</span>)}
        </div>
      ) : null}
    </div>
  );
}

/** The stacked mastery-tier bar plus its legend. Only tiers with at least one
 * word get a stack segment — a zero-count tier would render as nothing but an
 * extra 2px gap — but the legend always lists all four, so a tier reading
 * zero is still visible as a fact rather than silently missing. */
function LearningMasteryDistribution({
  distribution,
  scoped,
  labels,
}: {
  distribution: VocabMasteryDistribution;
  scoped: boolean;
  labels: ReadingStatsLabels;
}) {
  if (distribution.total === 0) return null;

  const tiers = [
    { key: "new", count: distribution.newCount, color: "var(--color-mastery-new)", label: labels.masteryTierNew },
    { key: "learning", count: distribution.learningCount, color: "var(--color-mastery-learning)", label: labels.masteryTierLearning },
    { key: "familiar", count: distribution.familiarCount, color: "var(--color-mastery-familiar)", label: labels.masteryTierFamiliar },
    { key: "mastered", count: distribution.masteredCount, color: "var(--color-mastery-mastered)", label: labels.masteryTierMastered },
  ];

  return (
    <div className="mt-5">
      <h3 className="text-[11.5px] font-semibold text-text-primary">{labels.learningDistributionTitle(distribution.total, scoped)}</h3>
      <p className="mt-0.5 text-[10px] text-text-muted">{labels.learningDistributionDescription}</p>
      <div className="mt-2.5 flex h-[22px] gap-0.5 overflow-hidden rounded-md">
        {tiers.filter((tier) => tier.count > 0).map((tier) => (
          <i key={tier.key} className="block h-full rounded-sm" style={{ flex: tier.count, background: tier.color }} />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[10.5px] text-text-secondary">
        {tiers.map((tier) => (
          <span key={tier.key} className="inline-flex items-center gap-1.5">
            <i className="inline-block size-[9px] rounded-[2.5px]" style={{ background: tier.color }} aria-hidden="true" />
            {tier.label}
            <b className="font-semibold text-text-primary">{tier.count}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The reading-stats page's third view, alongside history/calendar
 * (`docs/impls/reading-stats-learning-mockup.html`): what the reader's
 * lookups and vocabulary show for the selected period. Every number here is
 * computed on-device — no AI involved, see `labels.learningFootnote`.
 *
 * Collapses to a single quiet line when the period holds neither a lookup
 * nor a newly-saved word — the metrics/trend/distribution card would
 * otherwise just be four zeroes and two empty charts.
 */
function LearningView({
  learning,
  scoped,
  labels,
  onOpenReview,
}: {
  learning: VocabLearningStats;
  scoped: boolean;
  labels: ReadingStatsLabels;
  onOpenReview?: () => void;
}) {
  const isEmpty = learning.lookupCount === 0 && learning.newWordsCount === 0;

  return (
    <section aria-labelledby="reading-learning-heading">
      <div className="mb-3">
        <h2 id="reading-learning-heading" className="text-[13px] font-semibold text-text-primary">{labels.learningHeading(scoped)}</h2>
        <p className="mt-1 text-[10px] text-text-muted">{labels.learningDescription(scoped)}</p>
      </div>

      {isEmpty ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-6 text-center">
          <p className="text-[11.5px] font-medium text-text-primary">{labels.learningEmptyTitle}</p>
          <p className="mx-auto mt-1.5 max-w-sm whitespace-pre-line text-[10px] leading-5 text-text-muted">{labels.learningEmptyDescription}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-bg-surface p-5">
          <div className="grid grid-cols-4">
            <div className="pr-4">
              <strong className="block font-serif text-[19px] font-medium text-text-primary">{learning.lookupCount}</strong>
              <span className="mt-0.5 block text-[10px] text-text-muted">{labels.learningLookupCount}</span>
            </div>
            <div className="border-l border-border-light px-4">
              <strong className="block font-serif text-[19px] font-medium text-text-primary">{learning.newWordsCount}</strong>
              <span className="mt-0.5 block text-[10px] text-text-muted">{labels.learningNewWords}</span>
            </div>
            <div className="border-l border-border-light px-4">
              <strong className="block font-serif text-[19px] font-medium text-text-primary">{learning.masteredCount}</strong>
              <span className="mt-0.5 block text-[10px] text-text-muted">{labels.learningMastered}</span>
            </div>
            <div className="border-l border-border-light pl-4">
              <strong className="block font-serif text-[19px] font-medium text-text-primary">{learning.dueForReviewCount}</strong>
              <span className="mt-0.5 flex items-center gap-1 text-[10px] text-text-muted">
                {labels.learningDueForReview}
                <button
                  type="button"
                  onClick={onOpenReview}
                  disabled={!onOpenReview}
                  className="inline-flex items-center gap-0.5 font-medium text-accent-text disabled:cursor-default disabled:opacity-60"
                >
                  {labels.learningGoToReview}
                  <ArrowRight size={10} aria-hidden="true" />
                </button>
              </span>
            </div>
          </div>

          <div className="mt-5 border-t border-border-light pt-5">
            <LearningTrendChart trend={learning.trend} granularity={learning.trendGranularity} labels={labels} />
          </div>

          <LearningMasteryDistribution distribution={learning.masteryDistribution} scoped={scoped} labels={labels} />

          <p className="mt-4 border-t border-border-light pt-3 text-[10px] leading-[1.7] text-text-muted">{labels.learningFootnote}</p>
        </div>
      )}
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

/**
 * The declared level, held against the reader's own lookup record. Last thing
 * on the page and the quietest: no accent panel, no icon, no badge — it earns
 * attention by being read, not by catching the eye on the way past.
 *
 * The three variants differ only in the sentence and in which buttons exist.
 * `labels.levelRules` always leads with the sentence that says this row never
 * changes the setting by itself, and it is rendered outside every branch, so
 * there is no variant that can be written without it.
 */
function LevelObservationRow({
  observation,
  labels,
  onApply,
  onKeep,
  onStop,
  onOpenSettings,
}: {
  observation: LevelObservation;
  labels: ReadingStatsLabels;
  onApply(level: string): void;
  onKeep(): void;
  onStop(): void;
  onOpenSettings(): void;
}) {
  const effect = labels.levelEffect(observation);
  const topicalNote = labels.levelTopicalNote(observation);
  const suggested = observation.suggestedLevel;

  return (
    <section aria-labelledby="level-observation-heading">
      <div className="mb-3">
        <h2 id="level-observation-heading" className="text-[13px] font-semibold text-text-primary">
          {labels.levelHeading}
        </h2>
        <p className="mt-1 text-[10.5px] text-text-muted">{labels.levelDescription}</p>
      </div>
      <div className="rounded-xl border border-border bg-bg-surface p-5">
        <div className="flex items-baseline justify-between gap-5">
          <h3 className="text-[12.5px] font-semibold text-text-primary">
            {labels.levelDeclared(observation.declaredLevel)}
          </h3>
          <span className="shrink-0 text-[10.5px] text-text-muted">
            {labels.levelBasis(observation.windowDays)}
          </span>
        </div>

        <p className="mt-2.5 max-w-[660px] font-serif text-[15px] leading-7 text-text-secondary">
          {splitEmphasis(labels.levelBody(observation)).map((part, index) => (
            part.emphasis
              ? <strong key={index} className="font-semibold text-text-primary">{part.text}</strong>
              : <span key={index}>{part.text}</span>
          ))}
        </p>

        {topicalNote ? (
          // Why the totals above may undercount the record the reader can
          // see: screened-out lookups are named, never silently dropped.
          <p className="mt-2 max-w-[640px] text-[11.5px] leading-[1.8] text-text-muted">{topicalNote}</p>
        ) : null}

        {effect ? (
          <p className="mt-2.5 max-w-[640px] text-[11.5px] leading-[1.8] text-text-secondary">{effect}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {suggested ? (
            <>
              <button
                type="button"
                onClick={() => onApply(suggested)}
                className="h-8 rounded-lg border border-border bg-bg-surface px-3 text-[12px] text-text-secondary hover:bg-bg-input"
              >
                {labels.levelApply(suggested)}
              </button>
              <button type="button" onClick={onKeep} className="h-8 rounded-lg px-3 text-[12px] text-text-muted hover:bg-bg-input">
                {labels.levelKeep(observation.declaredLevel)}
              </button>
              <button type="button" onClick={onStop} className="h-8 rounded-lg px-3 text-[12px] text-text-muted hover:bg-bg-input">
                {labels.levelStop}
              </button>
            </>
          ) : (
            // No suggestion to accept or decline — but "stop" is about the
            // comparison, not about a suggestion, so it belongs here too.
            // Without it this variant would be the one row on the page the
            // reader cannot get rid of.
            <>
              <button type="button" onClick={onOpenSettings} className="h-8 rounded-lg px-3 text-[12px] text-text-muted hover:bg-bg-input">
                {labels.levelOpenSettings}
              </button>
              <button type="button" onClick={onStop} className="h-8 rounded-lg px-3 text-[12px] text-text-muted hover:bg-bg-input">
                {labels.levelStop}
              </button>
            </>
          )}
        </div>

        <p className="mt-3 border-t border-border-light pt-3 text-[10px] leading-[1.7] text-text-muted">
          {labels.levelRules(observation).join(" ")}
        </p>
      </div>
    </section>
  );
}

export default function ReadingStats({
  adapter,
  labels,
  provider,
  aiReviewDisclosureAcknowledged,
  onAcknowledgeAiReviewDisclosure,
  onOpenBook,
  onOpenLevelSettings,
  onOpenReview,
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
  const [autoOffer, setAutoOffer] = useState<AutoReviewOffer | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [acknowledgedLocally, setAcknowledgedLocally] = useState(aiReviewDisclosureAcknowledged);
  const [levelObservation, setLevelObservation] = useState<LevelObservation | null>(null);
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

  useEffect(() => {
    let disposed = false;
    adapter.autoReviewOffer?.().then((next) => {
      if (!disposed) setAutoOffer(next);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [adapter]);

  // Deliberately not keyed on `query`. The comparison reads a fixed recent
  // window of the reader's own record; narrowing the page to one book or to
  // last year does not change what their level is.
  useEffect(() => {
    let disposed = false;
    adapter.loadLevelObservation?.().then((next) => {
      if (!disposed) setLevelObservation(next);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [adapter]);

  // All three settle this observation, so all three clear the row. Nothing
  // here re-derives a verdict on the reader's behalf: the row is gone until
  // the record next has something different to say.
  const applyLevel = useCallback(async (level: string) => {
    try {
      await adapter.applyLevelSuggestion?.(level);
      setLevelObservation(null);
    } catch {
      /* The setting is unchanged and the row stays as it was. */
    }
  }, [adapter]);

  const keepLevel = useCallback(async () => {
    await adapter.keepDeclaredLevel?.().catch(() => {});
    setLevelObservation(null);
  }, [adapter]);

  const stopLevelObservation = useCallback(async () => {
    await adapter.stopLevelObservation?.().catch(() => {});
    setLevelObservation(null);
  }, [adapter]);

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
      // Only a run that succeeded counts. A failed one spent nothing and
      // proved nothing, and the offer's whole argument is that the reader
      // has kept coming back to something that works.
      const offer = await adapter.noteManualReview?.();
      if (offer) setAutoOffer(offer);
    } catch (error) {
      setReviewError(reviewErrorCode(error));
    } finally {
      setGenerating(false);
    }
  }, [adapter, provider.configured, query]);

  const acceptAuto = useCallback(async () => {
    setAutoOffer(await adapter.acceptAutoReview?.() ?? null);
  }, [adapter]);

  const declineAuto = useCallback(async () => {
    setAutoOffer(await adapter.declineAutoReview?.() ?? null);
  }, [adapter]);

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
          <p className="mt-1 text-[11px] text-text-muted">{view === "history" ? labels.subtitleHistory : view === "calendar" ? labels.subtitleCalendar : labels.subtitleLearning}</p>
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
            {(["history", "calendar", "learning"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`h-7 rounded-md px-2.5 text-[10px] ${view === value ? "bg-bg-surface font-medium text-accent-text shadow-sm" : "text-text-muted"}`}>
                {value === "history" ? labels.historyView : value === "calendar" ? labels.calendarView : labels.learningView}
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

        <ReviewPanel review={dashboard.cachedReview} pendingReason={dashboard.reviewPendingReason} provider={provider} labels={labels} generating={generating} error={reviewError} onGenerate={requestGenerate} autoOffer={autoOffer} onAcceptAuto={() => void acceptAuto()} onDeclineAuto={() => void declineAuto()} />

        {view === "history"
          ? <BookHistory books={dashboard.books} labels={labels} onOpenBook={onOpenBook} />
          : view === "calendar"
          ? <ReadingCalendar days={dashboard.calendar} labels={labels} />
          : <LearningView learning={dashboard.learning} scoped={bookId !== null} labels={labels} onOpenReview={onOpenReview} />}

        {loadError ? (
          <div role="status" className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-[10px] text-danger-text">
            <AlertCircle size={13} aria-hidden="true" />{labels.loadFailed}
            <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="ml-auto underline">{labels.retry}</button>
          </div>
        ) : null}

        {/* Last on the page, after the book list and before the privacy note
            behind the lock button in the header. It never appears anywhere
            else — no popup, no badge, no dot. */}
        {levelObservation ? (
          <LevelObservationRow
            observation={levelObservation}
            labels={labels}
            onApply={(level) => void applyLevel(level)}
            onKeep={() => void keepLevel()}
            onStop={() => void stopLevelObservation()}
            onOpenSettings={() => onOpenLevelSettings?.()}
          />
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
