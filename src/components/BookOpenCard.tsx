import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import Button from "./ui/Button";
import RidgeChart from "./RidgeChart";
import type { Book } from "../hooks/useBooks";
import { useBookDifficulty, getBookDifficulty, type BookDifficulty } from "../hooks/useBookDifficulty";
import { useBookDifficultySections, useReadingPace, useVocabPassRates } from "../hooks/useOpenCardData";
import { useOcrPackage } from "../hooks/useOcrPackage";
import { useOcrJob } from "../hooks/useOcrJob";
import { OCR_ACTIVE_JOB_STATES, formatOcrBytes } from "../ocr/types";
import {
  bandShares,
  classifyOpenCardBody,
  classifyRidge,
  disclosureRows,
  estimateRemainingWords,
  formatApproxHours,
  referenceBookComparison,
  roundPercent,
  weightedHardShare,
  type BandPassRates,
} from "./book-open-card-view";
import { bandSlices, hardShare } from "../pages/book-details/difficulty-view";
import { markEmphasis, splitEmphasis } from "../i18n/emphasis";

interface ReferenceBook {
  book: Book;
  difficulty: BookDifficulty;
}

interface BookListPage {
  books: Book[];
}

/** The most recently finished *other* book with a completed difficulty row,
 *  for the §1 "lighter/heavier/about the same" comparison line. `null` means
 *  there is nothing to compare against yet, which is a normal answer, not a
 *  failure — the comparison line simply does not render. */
function useReferenceBook(excludeBookId: string): ReferenceBook | null | undefined {
  const [reference, setReference] = useState<ReferenceBook | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setReference(undefined);
    invoke<BookListPage>("list_books", {
      filter: "finished",
      search: null,
      collectionId: null,
      cursor: null,
      limit: 2,
    })
      .then(async (page) => {
        const candidate = page.books.find((b) => b.id !== excludeBookId);
        if (!candidate) {
          if (alive) setReference(null);
          return;
        }
        const difficulty = await getBookDifficulty(candidate.id).catch(() => null);
        if (!alive) return;
        setReference(difficulty && difficulty.status === "done" ? { book: candidate, difficulty } : null);
      })
      .catch(() => {
        if (alive) setReference(null);
      });
    return () => {
      alive = false;
    };
  }, [excludeBookId]);
  return reference;
}

interface BookOpenCardProps {
  book: Book;
  onClose: () => void;
  onContinue: () => void;
  onHideForever: () => void;
}

/**
 * The full-screen "book open card" (`docs/impls/book-open-card-mockup.html`).
 * `BookOpenGateProvider` decides *whether* this renders at all; everything
 * here is about which of the mockup's states this one book is in and what
 * that state says.
 */
export default function BookOpenCard({ book, onClose, onContinue, onHideForever }: BookOpenCardProps) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  const { difficulty, loading: difficultyLoading, compute } = useBookDifficulty(book.id);
  const passRates = useVocabPassRates(true);
  const sections = useBookDifficultySections(book.id);
  const pace = useReadingPace(book.id);
  const reference = useReferenceBook(book.id);

  const passRatesSufficient = passRates.value?.sufficient ?? false;
  const bodyState = difficultyLoading ? null : classifyOpenCardBody(book, difficulty, passRatesSufficient);
  const isScanned = bodyState === "scanned";

  const ocrPackage = useOcrPackage(isScanned);
  const ocrJob = useOcrJob(isScanned ? book.id : undefined, isScanned);
  const [autoStartAfterDownload, setAutoStartAfterDownload] = useState(false);
  useEffect(() => {
    if (autoStartAfterDownload && ocrPackage.status?.state === "installed") {
      setAutoStartAfterDownload(false);
      void ocrJob.start();
    }
  }, [autoStartAfterDownload, ocrPackage, ocrJob]);

  const showStaleBanner = Boolean(difficulty?.stale) && difficulty?.status !== "unsupported";
  const primaryLabel = book.progress > 0 ? t("bookOpenCard.continueReading") : t("bookOpenCard.startReading");

  const passRateTuple: BandPassRates = passRates.value?.bandPassRates ?? [null, null, null, null, null];
  const shares = difficulty ? bandShares(difficulty) : ([0, 0, 0, 0, 0] as const);
  const weighted = weightedHardShare(shares, passRateTuple);
  const weightedPercent = roundPercent(weighted);

  let referenceLine: string | null = null;
  if (reference && difficulty) {
    const refShares = bandShares(reference.difficulty);
    const refWeighted = weightedHardShare(refShares, passRateTuple);
    const cmp = referenceBookComparison(weighted, refWeighted);
    const key = cmp === "referenceLighter"
      ? "compareReferenceLighter"
      : cmp === "referenceHeavier"
        ? "compareReferenceHeavier"
        : "compareReferenceSimilar";
    referenceLine = t(`bookOpenCard.${key}`, { title: reference.book.title });
  }

  const ridge = difficulty
    ? classifyRidge(sections.value ?? [], book, difficulty.status)
    : { kind: "unavailable" as const };

  const remainingWords = difficulty ? estimateRemainingWords(difficulty.totalTokens, book.progress / 100) : 0;
  const wpm = pace.value?.bookWordsPerMinute ?? pace.value?.overallWordsPerMinute ?? null;
  const hoursKey = pace.value?.bookWordsPerMinute ? "factsHoursAtBookPace" : "factsHoursAtPace";
  const hours = formatApproxHours(remainingWords, wpm);

  function handleDownloadAndRecognize() {
    if (ocrPackage.status?.state === "installed") {
      void ocrJob.start();
    } else {
      setAutoStartAfterDownload(true);
      void ocrPackage.download();
    }
  }

  function renderScanned() {
    const job = ocrJob.job;
    const pkg = ocrPackage.status;
    const jobActive = job !== null && OCR_ACTIVE_JOB_STATES.has(job.state);
    const pkgBusy = pkg !== null && ["downloading", "verifying", "installing"].includes(pkg.state);

    if (job && job.state === "failed") {
      return (
        <>
          <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">
            {t("bookOpenCard.recognitionFailedHeading")}
          </h2>
          <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">
            {t("bookOpenCard.recognitionFailedBody")}
          </p>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void ocrJob.retry()}>{t("bookOpenCard.retryRecognition")}</Button>
            <Button variant="secondary" onClick={onContinue}>{t("bookOpenCard.readDirectly")}</Button>
          </div>
        </>
      );
    }

    if (jobActive && job) {
      const known = job.pagesDone !== undefined && job.pagesTotal !== undefined && job.pagesTotal > 0;
      return (
        <>
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" />
            <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">
              {known ? t("bookOpenCard.recognizing", { done: job.pagesDone, total: job.pagesTotal }) : t("ocr.reader.working")}
            </h2>
          </div>
          <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.recognizingHint")}</p>
          {known ? (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-input">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.round(((job.pagesDone ?? 0) / (job.pagesTotal ?? 1)) * 100)}%` }}
              />
            </div>
          ) : null}
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => void ocrJob.cancel()}>{t("bookOpenCard.cancelRecognition")}</Button>
            <Button onClick={onContinue}>{t("bookOpenCard.goReadWhileRecognizing")}</Button>
          </div>
        </>
      );
    }

    if (pkgBusy && pkg) {
      return (
        <>
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" />
            <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">
              {t(`ocr.package.state.${pkg.state}`)}
            </h2>
          </div>
          {pkg.state === "downloading" ? (
            <>
              <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">
                {t("ocr.package.downloadSummary", {
                  downloaded: formatOcrBytes(pkg.downloadedBytes),
                  total: formatOcrBytes(pkg.totalBytes),
                })}
              </p>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-input">
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${pkg.totalBytes ? Math.round(((pkg.downloadedBytes ?? 0) / pkg.totalBytes) * 100) : 0}%` }}
                />
              </div>
            </>
          ) : null}
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => void ocrPackage.cancel()}>{t("ocr.actions.cancelDownload")}</Button>
            <Button onClick={onContinue}>{t("bookOpenCard.readDirectly")}</Button>
          </div>
        </>
      );
    }

    return (
      <>
        <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.scannedHeading")}</h2>
        <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.scannedBody")}</p>
        <p className="mt-2 text-[11.5px] leading-[1.7] text-text-muted">
          {t("bookOpenCard.scannedOcrHint", { size: formatOcrBytes(pkg?.totalBytes) })}
        </p>
        <div className="mt-4 flex gap-2">
          <Button onClick={handleDownloadAndRecognize}>{t("bookOpenCard.downloadAndRecognize")}</Button>
          <Button variant="secondary" onClick={onContinue}>{t("bookOpenCard.readDirectly")}</Button>
        </div>
      </>
    );
  }

  function renderNeverComputed() {
    return (
      <>
        <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.neverComputedHeading")}</h2>
        <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.neverComputedBody")}</p>
        <div className="mt-4">
          <Button onClick={() => void compute()}>{t("bookOpenCard.computeNow")}</Button>
        </div>
      </>
    );
  }

  function renderComputing() {
    return (
      <>
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="shrink-0 animate-spin text-accent-text" />
          <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.computingHeading")}</h2>
        </div>
        <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.computingBody")}</p>
      </>
    );
  }

  function renderNoConclusion() {
    if (!difficulty) return null;
    if (difficulty.status === "too_short") {
      return (
        <>
          <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.tooShortHeading")}</h2>
          <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">
            {t("bookOpenCard.tooShortBody", { tokens: numbers.format(difficulty.totalTokens), floor: numbers.format(5000) })}
          </p>
        </>
      );
    }
    if (difficulty.status === "unsupported") {
      return (
        <>
          <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.unsupportedHeading")}</h2>
          <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.unsupportedBody")}</p>
        </>
      );
    }
    return (
      <>
        <h2 className="m-0 font-serif text-[18px] leading-[1.5] text-text-primary">{t("bookOpenCard.genericFailedHeading")}</h2>
        <p className="mt-2 text-[12.5px] leading-[1.7] text-text-secondary">{t("bookOpenCard.genericFailedBody")}</p>
      </>
    );
  }

  function renderChapterBlock() {
    if (ridge.kind === "unavailable") return null;
    if (ridge.kind === "backfilling") {
      return (
        <div className="mt-5 rounded-lg border border-border-light bg-bg-muted px-3.5 py-3">
          <p className="m-0 text-[12px] font-medium text-text-secondary">{t("bookOpenCard.chapterBackfilling")}</p>
          <p className="mt-1 text-[11px] leading-[1.7] text-text-muted">{t("bookOpenCard.chapterBackfillingBody")}</p>
        </div>
      );
    }
    const peakLine = ridge.kind === "peak" ? t("bookOpenCard.chapterPeakLine", { title: ridge.peakTitle }) : t("bookOpenCard.chapterFlatLine");
    const body = ridge.kind === "peak" ? t("bookOpenCard.chapterPeakBody") : t("bookOpenCard.chapterFlatBody");
    return (
      <div className="mt-5">
        <p className="m-0 text-[12.5px] font-medium text-text-primary">{peakLine}</p>
        <p className="mt-1 text-[11px] leading-[1.7] text-text-muted">{body}</p>
        <RidgeChart bars={ridge.bars} className="mt-3" />
      </div>
    );
  }

  function renderBandBar() {
    if (!difficulty || difficulty.totalTokens <= 0) return null;
    const slices = bandSlices(difficulty);
    return (
      <div className="mt-5">
        <div className="flex h-3 overflow-hidden rounded-[5px] bg-bg-input" role="img" aria-label={t("bookDifficulty.barLabel")}>
          {slices.map((slice) => (
            <div
              key={slice.band ?? "unlisted"}
              style={{ width: `${slice.share * 100}%`, background: slice.color }}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {slices.map((slice) => (
            <span key={slice.band ?? "unlisted"} className="inline-flex items-center gap-1.5 text-[10px] text-text-muted">
              <i className="size-2 shrink-0 rounded-[2.5px]" style={{ background: slice.color }} aria-hidden="true" />
              {slice.band === null ? t("bookDifficulty.bandUnlisted") : t("bookDifficulty.bandName", { band: slice.band })}
            </span>
          ))}
        </div>
      </div>
    );
  }

  function renderDisclosure() {
    if (!difficulty) return null;
    const rows = disclosureRows(shares, passRateTuple);
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setDisclosureOpen((v) => !v)}
          className="flex items-center gap-1 text-[11.5px] font-medium text-accent-text"
        >
          {t("bookOpenCard.disclosureToggle")}
          {disclosureOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {disclosureOpen ? (
          <div className="mt-3 border-t border-border-light">
            <div className="grid grid-cols-[minmax(120px,1.2fr)_70px_90px_1fr] items-center gap-2 border-b border-border-light py-1.5 text-[9.5px] tracking-[0.03em] text-text-muted">
              <span>{t("bookOpenCard.disclosureColBand")}</span>
              <span>{t("bookOpenCard.disclosureColShare")}</span>
              <span>{t("bookOpenCard.disclosureColPassRate")}</span>
              <span>{t("bookOpenCard.disclosureColContribution")}</span>
            </div>
            {rows.map((row) => (
              <div key={row.band} className="grid grid-cols-[minmax(120px,1.2fr)_70px_90px_1fr] items-center gap-2 border-b border-border-light py-1.5">
                <span className="text-[11px] text-text-secondary">{t("bookDifficulty.bandName", { band: row.band })}</span>
                <span className="text-[11px] tabular-nums text-text-secondary">{row.bookSharePercent}%</span>
                <span className="text-[11px] tabular-nums text-text-secondary">
                  {row.passRatePercent === null ? "—" : `${row.passRatePercent}%`}
                </span>
                <span className="h-2 rounded-[2px] bg-accent/70" style={{ width: `${Math.max(row.contributionWidthPercent, 4)}%` }} />
              </div>
            ))}
            <div className="flex items-center justify-between py-1.5 text-[11px] font-medium text-text-primary">
              <span>{t("bookOpenCard.disclosureSum")}</span>
              <span className="tabular-nums">{weightedPercent}%</span>
            </div>
            <p className="mt-1 text-[10px] leading-[1.7] text-text-muted">{t("bookOpenCard.disclosureFootnote1")}</p>
            <p className="mt-1 text-[10px] leading-[1.7] text-text-muted">{t("bookOpenCard.disclosureFootnote2")}</p>
          </div>
        ) : null}
      </div>
    );
  }

  function renderFacts() {
    if (!difficulty || difficulty.totalTokens <= 0) return null;
    const parts = [
      t("bookOpenCard.formatLine", { format: book.format.toUpperCase(), words: numbers.format(difficulty.totalTokens) }),
    ];
    if (book.progress > 0) {
      parts.push(t("bookOpenCard.factsRemainingWords", { words: numbers.format(remainingWords) }));
    }
    if (hours !== null) {
      parts.push(t(`bookOpenCard.${hoursKey}`, { wpm: Math.round(wpm ?? 0), hours }));
    }
    return <p className="mt-4 text-[11px] leading-[1.7] text-text-muted">{parts.join(" · ")}</p>;
  }

  function renderInsufficientRecord() {
    if (!difficulty) return null;
    const bookOnlyPercent = roundPercent(hardShare(difficulty));
    return (
      <>
        <p className="m-0 font-serif text-[18px] leading-[1.6] text-text-primary">
          {splitEmphasis(t("bookOpenCard.verdictBookOnlyHard", { percent: markEmphasis(bookOnlyPercent) })).map((part, index) => (
            part.emphasis
              ? <strong key={index} className="font-semibold text-accent-text">{part.text}</strong>
              : <span key={index}>{part.text}</span>
          ))}
        </p>
        <p className="mt-2.5 max-w-[480px] text-[11px] leading-[1.8] text-text-secondary">
          {t("bookOpenCard.insufficientNote")}
        </p>
        {renderChapterBlock()}
        {renderBandBar()}
        {/* No disclosure here, deliberately. It is headed "这个数字怎么来的"
            and ends in a 合计 — but the number it decomposes is the weighted
            "对你" share, which is exactly the number this state has just said
            it cannot give yet. Rendered anyway, the card read "还说不上这本书
            对你算轻还是重" and then printed "合计 95%" four lines below it.
            Worse, with no pass-rate evidence every band's contribution
            collapses to its share, so the 贡献 column became a second copy of
            占篇幅 that appeared to say the commonest words were the hardest. */}
        {renderFacts()}
      </>
    );
  }

  function renderReady() {
    const verdictLine = t("bookOpenCard.verdictReady", {
      share: markEmphasis(t("bookOpenCard.sharePercent", { percent: weightedPercent })),
    });
    return (
      <>
        <p className="m-0 font-serif text-[18px] leading-[1.6] text-text-primary">
          {splitEmphasis(verdictLine).map((part, index) => (
            part.emphasis
              ? <strong key={index} className="font-semibold text-accent-text">{part.text}</strong>
              : <span key={index}>{part.text}</span>
          ))}
        </p>
        {referenceLine ? (
          <p className="mt-1.5 text-[12px] leading-[1.7] text-text-secondary">{referenceLine}</p>
        ) : null}
        {renderChapterBlock()}
        {renderBandBar()}
        {renderDisclosure()}
        {renderFacts()}
      </>
    );
  }

  function renderBody() {
    switch (bodyState) {
      case null:
        return (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        );
      case "scanned":
        return renderScanned();
      case "neverComputed":
        return renderNeverComputed();
      case "computing":
        return renderComputing();
      case "noConclusion":
        return renderNoConclusion();
      case "insufficientRecord":
        return renderInsufficientRecord();
      case "ready":
        return renderReady();
      default:
        return null;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6">
      <div className="relative flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-xl bg-bg-surface p-6 shadow-context">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("bookOpenCard.close")}
          className="absolute right-4 top-4 flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input"
        >
          <X size={15} />
        </button>
        <p className="m-0 max-w-[420px] pr-8 text-[13px] font-medium text-text-muted">{book.title}</p>

        {showStaleBanner ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-muted px-3.5 py-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
              <p className="m-0 max-w-[380px] text-[11px] leading-[1.7] text-text-secondary">{t("bookOpenCard.staleNote")}</p>
            </div>
            <Button size="sm" onClick={() => void compute()}>{t("bookOpenCard.recompute")}</Button>
          </div>
        ) : null}

        <div className={`mt-3 ${showStaleBanner ? "opacity-70" : ""}`}>{renderBody()}</div>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-border-light pt-4">
          <button
            type="button"
            onClick={onHideForever}
            className="text-[11.5px] text-text-muted hover:text-text-secondary"
          >
            {t("bookOpenCard.hideForever")}
          </button>
          <Button onClick={onContinue}>{primaryLabel}</Button>
        </div>
      </div>
    </div>
  );
}
