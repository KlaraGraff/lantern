import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

import { useSettings } from "../../hooks/useSettings";
import { saveVocabWord } from "../../components/vocab/collect";
import {
  useBookCoverage,
  getBookUnknownWords,
  type BookReaderCoverage,
  type CoverageProgress,
  type UnknownWord,
  type VocabProfileSummary,
} from "../../hooks/useBookCoverage";
import {
  compositionSlices,
  countFamiliarFrom,
  coverageBand,
  coverageBounds,
  coverageReading,
  formatCoverage,
  groupUnknownWords,
  isProfileEmpty,
  profileMovedOn,
  RARE_PREVIEW_LIMIT,
  scalePosition,
  shareAfterLearning,
  THRESHOLD_ASSISTED,
  THRESHOLD_INDEPENDENT,
  unknownWordsCsv,
  wordChip,
  type CoverageBand,
} from "./coverage-view";
import { markEmphasis, splitEmphasis } from "../../i18n/emphasis";

/**
 * "这本书对你" — the same book counted against this reader's own known words
 * instead of against the frequency table.
 *
 * Every state here is a state the data can actually be in, and two of them
 * exist precisely so the card never invents a number: an empty profile draws
 * the ruler with nothing on it, and a thin one draws a range. Neither prints a
 * percentage, because there isn't one to print.
 */
export default function CoverageSection({
  bookId,
  bookTitle,
  onStartReading,
}: {
  bookId: string;
  bookTitle: string;
  onStartReading(): void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const countFamiliar = countFamiliarFrom(settings);
  const { coverage, profile, progress, loading, callError, compute } = useBookCoverage(bookId);

  return (
    <section className="mt-6" aria-labelledby="book-coverage-heading">
      <div className="mb-3">
        <h2 id="book-coverage-heading" className="text-[13.5px] font-semibold">
          {t("bookCoverage.heading")}
        </h2>
        <p className="mt-1 text-[10.5px] text-text-muted">{t("bookCoverage.description")}</p>
      </div>
      <div className="rounded-[13px] border border-border px-5 py-[18px]">
        <CoverageBody
          bookId={bookId}
          bookTitle={bookTitle}
          countFamiliar={countFamiliar}
          coverage={coverage}
          profile={profile}
          progress={progress}
          loading={loading}
          callError={callError}
          onCompute={() => void compute()}
          onStartReading={onStartReading}
        />
      </div>
    </section>
  );
}

function CoverageBody({
  bookId,
  bookTitle,
  countFamiliar,
  coverage,
  profile,
  progress,
  loading,
  callError,
  onCompute,
  onStartReading,
}: {
  bookId: string;
  bookTitle: string;
  countFamiliar: boolean;
  coverage: BookReaderCoverage | null;
  profile: VocabProfileSummary | null;
  progress: CoverageProgress | null;
  loading: boolean;
  callError: string | null;
  onCompute(): void;
  onStartReading(): void;
}) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const dateOnly = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
    [i18n.language],
  );
  const [expanded, setExpanded] = useState(false);

  if (loading && !coverage) return <div className="h-14" />;

  if (!coverage) {
    return (
      <StateNote
        tone="bad"
        heading={t("bookCoverage.unavailable")}
        body={callError ?? t("bookCoverage.unavailableBody")}
      />
    );
  }

  const hasNumbers = coverage.totalTokens > 0 && coverage.computedAt !== null;
  const bounds = coverageBounds(coverage);
  const previousShare = countFamiliar ? bounds.upper : bounds.lower;

  // 05b — a recomputation over numbers that are already on screen. The old
  // ones stay, captioned with the profile they were actually computed from;
  // blanking them would trade a true-but-dated number for no number at all.
  if (coverage.status === "running" && hasNumbers) {
    return (
      <>
        <Ladder band={coverageBand(previousShare)} quiet />
        <p className="m-0 font-serif text-[19px] leading-[1.6] text-text-secondary">
          {emphasize(
            t("bookCoverage.line", {
              title: bookTitle,
              share: markEmphasis(`${formatCoverage(previousShare)}%`),
            }),
            "text-text-secondary",
          )}
        </p>
        <p className="mt-2.5 max-w-[560px] text-[11.5px] leading-[1.8] text-text-secondary">
          {coverage.profileAt
            ? t("bookCoverage.stale.profileLine", { date: dateOnly.format(new Date(coverage.profileAt)) })
            : t("bookCoverage.stale.profileLineUndated")}
        </p>
        <div className="mt-3.5 flex flex-wrap items-center gap-3.5 rounded-lg border border-border bg-bg-muted px-3.5 py-[11px]">
          <ScanBar className="min-w-[160px] flex-1" label={t("bookCoverage.running.heading")} />
          <span className="text-[11px] text-text-secondary">
            {progress && progress.totalTokens > 0
              ? t("bookCoverage.stale.recomputing", {
                percent: Math.min(99, Math.floor((progress.scannedTokens / progress.totalTokens) * 100)),
              })
              : t("bookCoverage.stale.recomputingUnknown")}
          </span>
        </div>
      </>
    );
  }

  // 05 — a first pass, with nothing to keep on screen behind it.
  if (coverage.status === "running") {
    return (
      <>
        <StateNote
          tone="running"
          heading={t("bookCoverage.running.heading")}
          body={progress && progress.totalTokens > 0
            ? t("bookCoverage.running.body", {
              total: numbers.format(progress.totalTokens),
              scanned: numbers.format(progress.scannedTokens),
            })
            : t("bookCoverage.running.bodyUnknown")}
        >
          <ScanBar className="mt-3.5 w-[min(420px,100%)]" label={t("bookCoverage.running.heading")} />
        </StateNote>
        <Footnote>{t("bookCoverage.running.local")}</Footnote>
      </>
    );
  }

  if (coverage.status === "failed") {
    return (
      <StateNote
        tone="bad"
        heading={t("bookCoverage.failed.heading")}
        body={coverage.error ?? t("bookCoverage.failed.body")}
      >
        <div className="mt-3">
          <QuietButton onClick={onCompute}>{t("bookCoverage.retry")}</QuietButton>
        </div>
      </StateNote>
    );
  }

  // Neither of these changes by being asked again: a few hundred words stay a
  // few hundred, and a format that yields no text yields none on the second
  // pass either. So neither offers a button.
  if (coverage.status === "too_short" || coverage.status === "unsupported") {
    return (
      <StateNote
        tone="idle"
        heading={t(`bookCoverage.${camel(coverage.status)}.heading`)}
        body={t(`bookCoverage.${camel(coverage.status)}.body`)}
      />
    );
  }

  // 03 — nothing recorded about this reader at all. The ruler is drawn with
  // no mark on it: the point is to teach what the two lines mean, not to put
  // a guess between them.
  if (isProfileEmpty(profile)) {
    return (
      <>
        <StateNote tone="idle" heading={t("bookCoverage.empty.heading")} body={t("bookCoverage.empty.body")}>
          <div className="mt-3.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onStartReading}
              className="h-8 rounded-lg bg-accent px-3 text-[12px] font-medium text-white"
            >
              {t("bookCoverage.empty.start")}
            </button>
          </div>
        </StateNote>
        <Scale hint={t("bookCoverage.scale.waiting")} />
        <SourceRows profile={profile} thin={false} />
        <Footnote>{t("bookCoverage.empty.footnote")}</Footnote>
      </>
    );
  }

  if (coverage.status === "pending" || !hasNumbers) {
    return (
      <StateNote
        tone="idle"
        heading={t("bookCoverage.pending.heading")}
        body={t("bookCoverage.pending.body")}
      >
        <div className="mt-3">
          <QuietButton onClick={onCompute}>{t("bookCoverage.pending.compute")}</QuietButton>
        </div>
      </StateNote>
    );
  }

  const reading = coverageReading(coverage, countFamiliar);

  // 04 — real data, not enough of it to land on a point.
  if (reading.kind === "interval") {
    return (
      <IntervalState
        bookTitle={bookTitle}
        coverage={coverage}
        profile={profile}
        low={reading.low}
        high={reading.high}
        spans={reading.spans}
        band={reading.band}
      />
    );
  }

  // 01 / 02 — one number, and which of the three cells it lands in.
  const slices = compositionSlices(coverage);
  const alternate = countFamiliar ? bounds.lower : bounds.upper;
  const notKnown = 1 - reading.share;
  const movedOn = profileMovedOn(coverage, profile);

  return (
    <>
      <Ladder band={reading.band} />

      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="m-0 font-serif text-[19px] leading-[1.6]">
            {emphasize(t("bookCoverage.line", {
              title: bookTitle,
              share: markEmphasis(`${formatCoverage(reading.share)}%`),
            }))}
          </p>
          <p className="mt-2.5 max-w-[560px] text-[11.5px] leading-[1.8] text-text-secondary">
            {emphasizeStrong(t(`bookCoverage.why.${reading.band}`, {
              unknown: markEmphasis(formatCoverage(notKnown)),
            }))}
          </p>
          <p className="mt-2 max-w-[560px] text-[11.5px] leading-[1.8] text-text-secondary">
            {emphasizeStrong(t("bookCoverage.why.sources", {
              forms: markEmphasis(numbers.format(coverage.masteredForms + (countFamiliar ? coverage.familiarForms : 0))),
              books: coverage.baselineBooks,
              nameWords: numbers.format(coverage.nameWords),
              nameTokens: numbers.format(coverage.nameTokens),
            }))}
          </p>
          {movedOn ? (
            <p className="mt-2 max-w-[560px] text-[10.5px] leading-[1.8] text-text-muted">
              {t("bookCoverage.profileMovedOn")}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-[10px] leading-[1.7] tabular-nums text-text-muted">
          {coverage.computedAt ? (
            <strong className="block text-[11px] font-semibold text-text-secondary">
              {t("bookCoverage.stamp.computedAt", { date: dateOnly.format(new Date(coverage.computedAt)) })}
            </strong>
          ) : null}
          <span className="block">{t("bookCoverage.stamp.sample", { tokens: numbers.format(coverage.totalTokens) })}</span>
          <span className="block">{t("bookCoverage.stamp.distinct", { words: numbers.format(coverage.distinctWords) })}</span>
          {coverage.profileAt ? (
            <span className="block">
              {t("bookCoverage.stamp.profileAt", { date: dateOnly.format(new Date(coverage.profileAt)) })}
            </span>
          ) : null}
        </div>
      </div>

      <Scale point={reading.share} />

      <div className="mt-5">
        <div className="flex h-4 overflow-hidden rounded-[5px] bg-bg-input" role="img" aria-label={t("bookCoverage.compo.head")}>
          {slices.map((slice) => (
            <span
              key={slice.key}
              className="grid place-items-center overflow-hidden whitespace-nowrap text-[9.5px] font-semibold tracking-[0.02em] text-text-secondary"
              style={{ width: `${slice.share * 100}%`, background: slice.color }}
            >
              {slice.share >= 0.05
                ? t("bookCoverage.compo.barLabel", {
                  name: t(`bookCoverage.row.${slice.key}.name`),
                  share: `${formatCoverage(slice.share)}%`,
                })
                : ""}
            </span>
          ))}
        </div>
        <div className="mt-3 border-t border-border-light">
          <div className="grid grid-cols-[minmax(150px,1.2fr)_1fr_74px] gap-3.5 border-b border-border-light px-0.5 py-[7px] text-[10px] tracking-[0.04em] text-text-muted">
            <span>{t("bookCoverage.compo.head")}</span>
            <span>{t("bookCoverage.compo.headHint")}</span>
            <span className="text-right">{t("bookCoverage.compo.headValue")}</span>
          </div>
          {slices.map((slice) => (
            <div
              key={slice.key}
              className="grid grid-cols-[minmax(150px,1.2fr)_1fr_74px] items-center gap-3.5 border-b border-border-light px-0.5 py-2.5"
            >
              <span className="flex items-center gap-2.5 text-[12px]">
                <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: slice.color }} aria-hidden="true" />
                {t(`bookCoverage.row.${slice.key}.name`)}
              </span>
              <span className="text-[10.5px] text-text-muted">{t(`bookCoverage.row.${slice.key}.hint`)}</span>
              <span className={`text-right font-serif text-[14px] font-medium tabular-nums ${slice.key === "name" ? "text-text-muted" : ""}`}>
                {formatCoverage(slice.share)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <Footnote
        links={
          <>
            <LinkButton onClick={() => setExpanded((open) => !open)}>
              {expanded
                ? t("bookCoverage.words.collapse")
                : t("bookCoverage.action.showWords", { share: `${formatCoverage(notKnown)}%` })}
            </LinkButton>
            <LinkButton onClick={onCompute}>{t("bookCoverage.action.recompute")}</LinkButton>
          </>
        }
      >
        {t(countFamiliar ? "bookCoverage.footnote.familiarOn" : "bookCoverage.footnote.familiarOff", {
          alternate: `${formatCoverage(alternate)}%`,
        })}
        {" "}
        {t("bookCoverage.footnote.ruler")}
        {" "}
        {t("bookCoverage.footnote.local")}
      </Footnote>

      {expanded ? (
        <UnknownWordsPanel
          bookId={bookId}
          bookTitle={bookTitle}
          coverage={coverage}
          countFamiliar={countFamiliar}
          share={reading.share}
          onCollapse={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}

function camel(status: "too_short" | "unsupported"): "tooShort" | "unsupported" {
  return status === "too_short" ? "tooShort" : "unsupported";
}

function emphasize(line: string, tone = "text-accent-text") {
  return splitEmphasis(line).map((part, index) => (
    part.emphasis
      ? <strong key={index} className={`font-semibold ${tone}`}>{part.text}</strong>
      : <span key={index}>{part.text}</span>
  ));
}

function emphasizeStrong(line: string) {
  return splitEmphasis(line).map((part, index) => (
    part.emphasis
      ? <strong key={index} className="font-semibold text-text-primary">{part.text}</strong>
      : <span key={index}>{part.text}</span>
  ));
}

/**
 * Three cells, one of them lit. Position carries the verdict — the same accent
 * paints whichever cell is on, so a book that is hard right now never gets
 * coloured like a warning.
 */
function Ladder({ band, quiet = false }: { band: CoverageBand; quiet?: boolean }) {
  const { t } = useTranslation();
  const cells: CoverageBand[] = ["dense", "assisted", "independent"];
  return (
    <div className="mb-3.5 inline-flex items-center gap-[9px]" aria-label={t(`bookCoverage.ladder.${band}`)}>
      <span className="inline-flex gap-[3px]" aria-hidden="true">
        {cells.map((cell) => (
          <i
            key={cell}
            className={`block h-[5px] w-[17px] rounded-sm ${cell === band ? (quiet ? "bg-accent/60" : "bg-accent") : "bg-border"}`}
          />
        ))}
      </span>
      <span className="text-[11px] tracking-[-0.1px] text-text-secondary">{t(`bookCoverage.ladder.${band}`)}</span>
    </div>
  );
}

/**
 * The ruler, 88% to 100%. Drawn with a point, with a range, or with neither —
 * the empty state shows the two reference lines and nothing else, which is the
 * only honest way to introduce a scale you have no reading for.
 */
function Scale({
  point,
  range,
  hint,
}: {
  point?: number;
  range?: { low: number; high: number };
  hint?: string;
}) {
  const { t } = useTranslation();
  const assisted = scalePosition(THRESHOLD_ASSISTED) * 100;
  const independent = scalePosition(THRESHOLD_INDEPENDENT) * 100;
  const left = range ? scalePosition(range.low) * 100 : 0;
  const width = range ? scalePosition(range.high) * 100 - left : 0;
  const mark = point === undefined ? null : scalePosition(point) * 100;
  const label = range
    ? t("bookCoverage.scale.rangeAria", { low: `${formatCoverage(range.low)}%`, high: `${formatCoverage(range.high)}%` })
    : point !== undefined
      ? t("bookCoverage.scale.pointAria", { share: `${formatCoverage(point)}%` })
      : t("bookCoverage.scale.emptyAria");

  return (
    <div className="mt-[18px]">
      <div className="relative h-[26px]">
        {mark !== null ? (
          <div className="absolute bottom-[calc(100%+6px)] -translate-x-1/2 whitespace-nowrap" style={{ left: `${mark}%` }}>
            <b className="font-serif text-[17px] font-semibold tabular-nums text-accent-text">{formatCoverage(point ?? 0)}%</b>
          </div>
        ) : null}
        {range ? (
          <div
            className="absolute bottom-[calc(100%+6px)] -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${left + width / 2}%` }}
          >
            <b className="font-serif text-[15px] font-semibold tabular-nums text-accent-text">
              {t("bookCoverage.scale.rangeValue", {
                low: `${formatCoverage(range.low)}%`,
                high: `${formatCoverage(range.high)}%`,
              })}
            </b>
          </div>
        ) : null}
      </div>
      <div className="relative h-[34px] overflow-hidden rounded-md bg-bg-input" role="img" aria-label={label}>
        {mark !== null ? (
          <div className="absolute inset-y-0 left-0 bg-band-2" style={{ width: `${mark}%` }} />
        ) : null}
        {range ? (
          <div
            className="absolute inset-y-0 border-x border-dashed border-band-4 bg-band-1"
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        ) : null}
        <div className="absolute inset-y-0 w-0 border-l border-dashed border-text-muted/65" style={{ left: `${assisted}%` }} />
        <div className="absolute inset-y-0 w-0 border-l border-dashed border-text-muted/65" style={{ left: `${independent}%` }} />
        {mark !== null ? (
          <div className="absolute -inset-y-px w-0.5 bg-accent" style={{ left: `${mark}%` }}>
            <span className="absolute left-1/2 top-1/2 -ml-[4.5px] -mt-[4.5px] size-[9px] rounded-full bg-accent shadow-[0_0_0_2.5px_var(--color-bg-surface)]" />
          </div>
        ) : null}
      </div>
      <div className="relative mt-[5px] h-[30px]">
        <div className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-center" style={{ left: `${assisted}%` }}>
          <b className="block text-[10.5px] font-semibold tabular-nums text-text-secondary">95%</b>
          <small className="mt-px block text-[9.5px] text-text-muted">{t("bookCoverage.scale.assisted")}</small>
        </div>
        <div className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-center" style={{ left: `${independent}%` }}>
          <b className="block text-[10.5px] font-semibold tabular-nums text-text-secondary">98%</b>
          <small className="mt-px block text-[9.5px] text-text-muted">{t("bookCoverage.scale.independent")}</small>
        </div>
      </div>
      <div className="mt-0.5 flex justify-between text-[9.5px] tabular-nums text-text-muted">
        <span>88%</span>
        <span className="px-2 text-center">{hint ?? t("bookCoverage.scale.floorNote")}</span>
        <span>100%</span>
      </div>
    </div>
  );
}

/**
 * The four things a vocabulary profile is built out of. Shown by the empty
 * state and the thin-sample state, in both cases so the reader can see what
 * would make the number appear or the range narrow — rather than being told to
 * wait.
 */
function SourceRows({ profile, thin }: { profile: VocabProfileSummary | null; thin: boolean }) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const summary = profile;

  const rows: Array<{ key: string; hint: string; value: string; none: boolean }> = [
    {
      key: "books",
      hint: thin ? t("bookCoverage.sources.books.hintThin") : t("bookCoverage.sources.books.hint"),
      value: !summary || summary.booksRead === 0
        ? t("bookCoverage.sources.none")
        : summary.singleBookProgress !== null
          ? t("bookCoverage.sources.books.valueOne", { books: summary.booksRead, percent: Math.round(summary.singleBookProgress) })
          : t("bookCoverage.sources.books.value", { books: summary.booksRead }),
      none: !summary || summary.booksRead === 0,
    },
    {
      key: "exposures",
      hint: thin && summary
        ? t("bookCoverage.sources.exposures.hintThin", { forms: numbers.format(summary.masteredForms + summary.familiarForms) })
        : t("bookCoverage.sources.exposures.hint"),
      value: !summary || summary.exposureTokens === 0
        ? t("bookCoverage.sources.none")
        : t("bookCoverage.sources.exposures.value", {
          tokens: numbers.format(summary.exposureTokens),
          words: numbers.format(summary.exposureWords),
        }),
      none: !summary || summary.exposureTokens === 0,
    },
    {
      key: "lookups",
      hint: thin && summary && summary.lookupDays > 0
        ? t("bookCoverage.sources.lookups.hintThin", { days: summary.lookupDays })
        : t("bookCoverage.sources.lookups.hint"),
      value: !summary || summary.lookupRecords === 0
        ? t("bookCoverage.sources.none")
        : t("bookCoverage.sources.lookups.value", { records: numbers.format(summary.lookupRecords) }),
      none: !summary || summary.lookupRecords === 0,
    },
    {
      key: "vocab",
      hint: t("bookCoverage.sources.vocab.hint"),
      value: !summary || summary.vocabWords === 0
        ? t("bookCoverage.sources.none")
        : summary.reviewedWords === 0
          ? t("bookCoverage.sources.vocab.valueUnreviewed", { words: numbers.format(summary.vocabWords) })
          : t("bookCoverage.sources.vocab.value", {
            words: numbers.format(summary.vocabWords),
            reviewed: numbers.format(summary.reviewedWords),
          }),
      none: !summary || summary.vocabWords === 0,
    },
  ];

  return (
    <div className="mt-4 border-t border-border-light">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-5 border-b border-border-light px-0.5 py-[11px]">
          <span className="text-[12px]">
            {t(`bookCoverage.sources.${row.key}.label`)}
            <small className="mt-0.5 block text-[10.5px] text-text-muted">{row.hint}</small>
          </span>
          <span className={`text-[12px] tabular-nums ${row.none ? "text-text-muted" : "text-text-secondary"}`}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 04 — a range, and the reason it is a range rather than a point. */
function IntervalState({
  bookTitle,
  coverage,
  profile,
  low,
  high,
  spans,
  band,
}: {
  bookTitle: string;
  coverage: BookReaderCoverage;
  profile: VocabProfileSummary | null;
  low: number;
  high: number;
  spans: number[];
  band: CoverageBand | null;
}) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const [explained, setExplained] = useState(false);
  // Which gate is why. Both can fail at once; the sample gate is the one the
  // reader can do something about, so it wins the sentence.
  const thinSample = coverage.baselineBooks < 2;
  const named = profile?.singleBookTitle ?? null;

  const verdict = spans.length > 0
    ? t("bookCoverage.interval.spans", {
      line: `${formatCoverage(spans[0])}%`,
      lower: t(`bookCoverage.ladder.${spans[0] === THRESHOLD_ASSISTED ? "dense" : "assisted"}`),
      upper: t(`bookCoverage.ladder.${spans[0] === THRESHOLD_ASSISTED ? "assisted" : "independent"}`),
    })
    : band
      ? t("bookCoverage.interval.settled", { verdict: t(`bookCoverage.ladder.${band}`) })
      : "";

  return (
    <>
      <StateNote
        tone="idle"
        heading={t("bookCoverage.interval.heading")}
        body={[
          named && profile?.singleBookProgress !== null && profile?.singleBookProgress !== undefined
            ? t("bookCoverage.interval.bodyFromOne", {
              forms: numbers.format(coverage.masteredForms + coverage.familiarForms),
              source: named,
              percent: Math.round(profile.singleBookProgress),
            })
            : t("bookCoverage.interval.body", {
              forms: numbers.format(coverage.masteredForms + coverage.familiarForms),
              books: coverage.baselineBooks,
            }),
          t("bookCoverage.interval.range", {
            title: bookTitle,
            low: `${formatCoverage(low)}%`,
            high: `${formatCoverage(high)}%`,
          }),
          verdict,
        ].filter(Boolean).join(" ")}
      />

      <Scale
        range={{ low, high }}
        hint={spans.length > 0
          ? t("bookCoverage.scale.spanNote", { line: `${formatCoverage(spans[0])}%` })
          : undefined}
      />

      <SourceRows profile={profile} thin />

      <Footnote
        links={<LinkButton onClick={() => setExplained((open) => !open)}>{t("bookCoverage.interval.explain")}</LinkButton>}
      >
        {thinSample ? t("bookCoverage.interval.footnoteSample") : t("bookCoverage.interval.footnoteWidth")}
        {explained ? <span className="mt-2 block">{t("bookCoverage.interval.explainBody")}</span> : null}
      </Footnote>
    </>
  );
}

/** 06 — the words behind the percentage that is missing. */
function UnknownWordsPanel({
  bookId,
  bookTitle,
  coverage,
  countFamiliar,
  share,
  onCollapse,
}: {
  bookId: string;
  bookTitle: string;
  coverage: BookReaderCoverage;
  countFamiliar: boolean;
  share: number;
  onCollapse(): void;
}) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const [words, setWords] = useState<UnknownWord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [collected, setCollected] = useState(0);

  useEffect(() => {
    let alive = true;
    setWords(null);
    setError(null);
    getBookUnknownWords(bookId, countFamiliar)
      .then((rows) => {
        if (alive) setWords(rows);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [bookId, countFamiliar]);

  const groups = useMemo(() => groupUnknownWords(words ?? []), [words]);
  const frequent = groups.find((group) => group.key === "frequent");

  const exportCsv = useCallback(async () => {
    if (!words) return;
    setError(null);
    try {
      const path = await save({
        defaultPath: `${bookTitle}-unknown-words.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, unknownWordsCsv(words));
    } catch (reason) {
      setError(String(reason));
    }
  }, [words, bookTitle]);

  const collect = useCallback(async () => {
    if (!frequent || collecting) return;
    setCollecting(true);
    setError(null);
    try {
      // The repo's one save path, so these rows are indistinguishable from a
      // word saved off the selection menu — same gloss resolution, same sync
      // event, same review queue.
      for (const entry of frequent.words) {
        await saveVocabWord({ bookId, word: entry.word, gloss: entry.gloss });
      }
      setCollected(frequent.words.length);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCollecting(false);
    }
  }, [frequent, collecting, bookId]);

  return (
    <div className="mt-5 rounded-[13px] border border-border px-5 py-[18px]">
      <div className="mb-3 flex items-start justify-between gap-5">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold">{t("bookCoverage.words.heading", { title: bookTitle })}</h3>
          <p className="mt-1 text-[10.5px] leading-[1.7] text-text-muted">
            {t("bookCoverage.words.description", {
              forms: numbers.format(coverage.unknownWords),
              tokens: numbers.format(coverage.unknownTokens),
            })}
          </p>
        </div>
        <LinkButton onClick={onCollapse}>{t("bookCoverage.words.collapse")}</LinkButton>
      </div>

      {error ? <p className="text-[11.5px] leading-[1.8] text-danger-text">{error}</p> : null}

      {words === null ? (
        <p className="text-[11.5px] text-text-muted">{t("bookCoverage.words.loading")}</p>
      ) : groups.length === 0 ? (
        <p className="text-[11.5px] text-text-secondary">{t("bookCoverage.words.empty")}</p>
      ) : (
        <div className="mt-1">
          {groups.map((group) => (
            <div key={group.key} className="mt-[18px] first:mt-0">
              <h4 className="flex items-baseline gap-2 text-[11px] font-semibold text-text-secondary">
                {t(`bookCoverage.words.group.${group.key}`)}
                <small className="text-[10.5px] font-normal text-text-muted">
                  {group.key === "frequent"
                    ? t("bookCoverage.words.groupMetaShare", {
                      forms: numbers.format(group.forms),
                      tokens: numbers.format(group.tokens),
                      share: `${formatCoverage(coverage.totalTokens > 0 ? group.tokens / coverage.totalTokens : 0)}%`,
                    })
                    : t("bookCoverage.words.groupMeta", {
                      forms: numbers.format(group.forms),
                      tokens: numbers.format(group.tokens),
                    })}
                </small>
              </h4>
              {group.key === "frequent" ? (
                <p className="mt-1 text-[10.5px] leading-[1.7] text-text-muted">
                  {t("bookCoverage.words.frequentNote", {
                    from: `${formatCoverage(share)}%`,
                    to: `${formatCoverage(shareAfterLearning(share, group.tokens, coverage.totalTokens))}%`,
                  })}
                </p>
              ) : null}
              {group.key === "rare" ? (
                <>
                  <p className="mt-1 text-[10.5px] leading-[1.7] text-text-muted">{t("bookCoverage.words.rareNote")}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {group.words.slice(0, RARE_PREVIEW_LIMIT).map((word) => (
                      <span key={word.word} className="rounded-[5px] bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                        {word.word}
                      </span>
                    ))}
                    {group.words.length > RARE_PREVIEW_LIMIT ? (
                      <span className="rounded-[5px] bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                        {t("bookCoverage.words.more", { rest: group.words.length - RARE_PREVIEW_LIMIT })}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="mt-1.5 border-t border-border-light">
                  {group.words.map((word) => {
                    const chip = wordChip(word);
                    return (
                      <div
                        key={word.word}
                        className="grid grid-cols-[minmax(120px,1fr)_1fr_92px_78px] items-center gap-3.5 border-b border-border-light px-0.5 py-[9px]"
                      >
                        <span className="text-[13px] font-medium">{word.word}</span>
                        <span className="text-[11px] text-text-muted">{word.gloss ?? ""}</span>
                        <span className="text-[10.5px] text-text-secondary">
                          <span className={`inline-block rounded-[5px] px-1.5 py-0.5 text-[10px] ${chip.kind === "familiar" ? "bg-accent-bg text-accent-text" : "bg-bg-input text-text-muted"}`}>
                            {chip.kind === "familiar"
                              ? t("bookCoverage.chip.familiar")
                              : chip.kind === "lookups"
                                ? t("bookCoverage.chip.lookups", { times: chip.count })
                                : chip.kind === "seen"
                                  ? t("bookCoverage.chip.seen", { times: chip.count })
                                  : t("bookCoverage.chip.never")}
                          </span>
                        </span>
                        <span className="text-right text-[11.5px] tabular-nums text-text-secondary">
                          {t("bookCoverage.words.count", { times: word.tokens })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Footnote
        links={
          <>
            {frequent ? (
              <LinkButton onClick={() => void collect()} disabled={collecting || collected > 0}>
                {collected > 0
                  ? t("bookCoverage.words.collected", { words: collected })
                  : t("bookCoverage.words.collect", { words: frequent.words.length })}
              </LinkButton>
            ) : null}
            {words && words.length > 0 ? (
              <LinkButton onClick={() => void exportCsv()}>{t("bookCoverage.words.export")}</LinkButton>
            ) : null}
          </>
        }
      >
        {t("bookCoverage.words.footnote", { tokens: numbers.format(coverage.nameTokens) })}
      </Footnote>
    </div>
  );
}

function StateNote({
  tone,
  heading,
  body,
  children,
}: {
  tone: "idle" | "running" | "bad";
  heading: string;
  body: string;
  children?: React.ReactNode;
}) {
  const dot = tone === "running" ? "bg-accent" : tone === "bad" ? "bg-danger-text" : "bg-text-muted/50";
  return (
    <div className="flex items-start gap-[11px]">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold">{heading}</h3>
        <p className="mt-1.5 max-w-[640px] text-[11.5px] leading-[1.8] text-text-secondary">{body}</p>
        {children}
      </div>
    </div>
  );
}

function ScanBar({ className = "", label }: { className?: string; label: string }) {
  return (
    <span
      className={`block h-[3px] overflow-hidden rounded-full bg-bg-input ${className}`}
      role="progressbar"
      aria-valuetext={label}
    >
      <span className="difficulty-scan block h-full w-1/3 rounded-full bg-accent/75" />
    </span>
  );
}

function Footnote({ children, links }: { children: React.ReactNode; links?: React.ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-start justify-between gap-5 border-t border-border pt-3">
      <p className="m-0 max-w-[620px] text-[10.5px] leading-[1.8] text-text-muted">{children}</p>
      {links ? <span className="flex shrink-0 gap-4">{links}</span> : null}
    </div>
  );
}

function LinkButton({
  onClick,
  disabled,
  children,
}: {
  onClick(): void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="whitespace-nowrap text-[11px] text-accent-text disabled:text-text-muted"
    >
      {children}
    </button>
  );
}

function QuietButton({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-lg border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input"
    >
      {children}
    </button>
  );
}
