import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, BookOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import {
  deleteBook,
  getBook,
  type Book,
} from "../hooks/useBooks";
import { useBookOpenGate } from "../components/BookOpenGateProvider";
import {
  getBookDifficulty,
  useBookDifficulty,
  type BookDifficulty,
  type BookDifficultyOverride,
} from "../hooks/useBookDifficulty";
import {
  bandSlices,
  baselineHardShare,
  difficultyVerdict,
  easyShare,
  effectiveVerdict,
  formatShare,
  hardShare,
  MIN_BASELINE_BOOKS,
  type DifficultyVerdict,
} from "./book-details/difficulty-view";
import { markEmphasis, splitEmphasis } from "../i18n/emphasis";
import { toBackendQuery } from "./reading-stats/tauri-adapter";
import CoverageSection from "./book-details/CoverageSection";
import EditMetadataModal from "../components/EditMetadataModal";
import DeleteBookDialog from "../components/DeleteBookDialog";
import BottomSheet from "../components/ui/BottomSheet";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { platform } from "../services/platform";

/**
 * What the OS puts above the header. On macOS that is the traffic lights, and
 * the reserve is theirs whatever the window's width — a user who drags the
 * window under 768px still has traffic lights. On a phone it is the status bar
 * and the notch, which `pt-safe-top` reads off the viewport. Same ternary as
 * `Home.tsx`, `Sidebar.tsx` and `Reader.tsx`: the reserve is a platform
 * question, never a width one.
 */
const TOP_INSET = platform.hasTitleBarInset ? "pt-titlebar" : "pt-safe-top";

/**
 * One cell of the metrics strip, which is 2×2 on a phone and 1×4 on a desktop.
 *
 * Written as a function of the index rather than four literal class strings
 * because the two layouts disagree about exactly one cell: the third. It opens
 * a row when the strip is 2×2 (so no rule to its left) and sits mid-strip when
 * the strip is 1×4 (so it needs one). Everything else follows from "odd cells
 * have a neighbour to their left" and "the first row has a row under it".
 */
function metricCellClass(index: number): string {
  const vertical = index === 0
    ? "pr-[18px]"
    : index === 2
      ? "pr-[18px] md:border-l md:border-border md:pl-[18px]"
      : "border-l border-border pl-[18px] md:pr-[18px]";
  const horizontal = index < 2
    ? "border-b border-border-light pb-3 md:border-b-0 md:pb-0"
    : "pt-3 md:pt-0";
  return `${vertical} ${horizontal}`;
}

/** How far back to look for books to build a baseline from. Finished books
 *  only, newest first — a shelf of two hundred should not cost two hundred
 *  round trips to answer "harder than what you usually read". */
const BASELINE_SAMPLE = 12;

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

/** What the page can say about how long this book has been read for, and how
 *  much has been written on it. Both are side facts; neither blocks a render. */
interface BookSideFacts {
  activeSeconds: number;
  annotations: number;
  notes: number;
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function BookDetails() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const requestOpen = useBookOpenGate();

  const [book, setBook] = useState<Book | null>(null);
  const [missing, setMissing] = useState(false);
  const [facts, setFacts] = useState<BookSideFacts | null>(null);
  const [baseline, setBaseline] = useState<{ value: number | null; books: number }>({ value: null, books: 0 });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  // Edit and delete come off the header on a phone: three buttons and a back
  // link do not share 390px, and the one that has to stay is the one the page
  // exists for. Delete being a tap further away is a bonus, not the reason.
  const [moreOpen, setMoreOpen] = useState(false);
  const isNarrow = useIsNarrow();

  const { difficulty, loading, callError, compute, setOverride } = useBookDifficulty(id);

  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const dateTime = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
    [i18n.language],
  );
  const dateOnly = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
    [i18n.language],
  );

  const loadBook = useCallback(() => {
    if (!id) return;
    getBook(id)
      .then((next) => setBook(next))
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(() => loadBook(), [loadBook]);

  // Reading time and annotation counts. Three independent reads, each allowed
  // to come back empty: a metric that cannot be sourced shows a dash, and
  // none of them is a reason to fail the page.
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    Promise.all([
      invoke<{ overview: { totalActiveSeconds: number } }>("get_reading_stats_dashboard", {
        query: toBackendQuery({ range: "all", bookId: id }),
      }).then((value) => value.overview.totalActiveSeconds).catch(() => 0),
      invoke<{ total: number }>("list_annotations", { bookId: id, limit: 1 })
        .then((value) => value.total).catch(() => 0),
      invoke<{ total: number }>("list_notes", { bookId: id, limit: 1 })
        .then((value) => value.total).catch(() => 0),
    ]).then(([activeSeconds, annotations, notes]) => {
      if (!disposed) setFacts({ activeSeconds, annotations, notes });
    });
    return () => { disposed = true; };
  }, [id]);

  // "Harder than what you usually read" is a claim about the reader's shelf,
  // so the shelf has to be read to make it. Finished books only — a book
  // abandoned at 4% says nothing about what its reader can carry.
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    invoke<BookPage>("list_books", {
      filter: "finished",
      search: null,
      collectionId: null,
      cursor: null,
      limit: null,
    })
      .then(async (page) => {
        const candidates = page.books.filter((other) => other.id !== id).slice(0, BASELINE_SAMPLE);
        const rows = await Promise.all(
          candidates.map((other) => getBookDifficulty(other.id).catch(() => null)),
        );
        const usable = rows.filter((row): row is BookDifficulty => row !== null && row.status === "done");
        if (!disposed) setBaseline({ value: baselineHardShare(usable), books: usable.length });
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [id]);

  const remove = useCallback(async (policy: "delete" | "preserve") => {
    if (!id) return;
    await deleteBook(id, policy === "preserve");
    navigate("/");
  }, [id, navigate]);

  if (missing) {
    return (
      <main className="grid h-screen place-items-center bg-bg-surface px-6 text-center">
        <div>
          <p className="text-[12px] text-text-muted">{t("bookDetails.missing")}</p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-4 h-8 rounded-lg bg-accent px-3 text-[11px] font-medium text-white"
          >
            {t("bookDetails.backToLibrary")}
          </button>
        </div>
      </main>
    );
  }

  if (!book) {
    return <div className="h-screen bg-bg-page" />;
  }

  const addedAt = dateTime.format(new Date(book.created_at));
  const statusLabel = book.status === "reading"
    ? t("bookMenu.currentlyReading")
    : book.status === "finished"
      ? t("bookMenu.finished")
      : t("bookMenu.notStarted");

  const duration = facts
    ? facts.activeSeconds >= 3600
      ? t("bookDetails.durationHm", {
        hours: Math.floor(facts.activeSeconds / 3600),
        minutes: Math.floor((facts.activeSeconds % 3600) / 60),
      })
      : t("bookDetails.durationM", { minutes: Math.floor(facts.activeSeconds / 60) })
    : "—";

  const tokenMetric = difficulty && difficulty.totalTokens > 0
    ? numbers.format(difficulty.totalTokens)
    : "—";

  const metrics: Array<[string, string]> = [
    [`${Math.round(book.progress)}%`, t("bookDetails.metricProgress")],
    [duration, t("bookDetails.metricFocused")],
    [tokenMetric, t("bookDetails.metricTokens")],
    [facts ? numbers.format(facts.annotations + facts.notes) : "—", t("bookDetails.metricMarks")],
  ];

  return (
    <main className="h-screen overflow-y-auto bg-bg-surface text-text-primary">
      <header className={`sticky top-0 z-20 flex min-h-[72px] items-end justify-between gap-3 border-b border-border bg-bg-surface/95 px-4 pb-2.5 ${TOP_INSET} backdrop-blur md:min-h-[96px] md:gap-5 md:px-7 md:pb-3.5`}>
        <button
          type="button"
          onClick={() => navigate("/")}
          aria-label={isNarrow ? t("bookDetails.backToLibrary") : undefined}
          className="flex h-11 shrink-0 items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary md:h-auto"
        >
          <ArrowLeft size={isNarrow ? 20 : 15} aria-hidden="true" />
          <span className="hidden md:inline">{t("bookDetails.backToLibrary")}</span>
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => requestOpen(book)}
            className="inline-flex h-11 min-w-0 items-center gap-1.5 rounded-lg bg-accent px-4 text-[14px] font-medium text-white md:h-8 md:px-3 md:text-[12px]"
          >
            <BookOpen size={14} aria-hidden="true" className="shrink-0" />
            <span className="truncate">
              {book.progress > 0 ? t("bookDetails.continueReading") : t("bookDetails.startReading")}
            </span>
          </button>
          {isNarrow ? (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label={t("bookDetails.moreActions")}
              className="grid size-11 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input"
            >
              <MoreHorizontal size={20} aria-hidden="true" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="h-8 rounded-lg border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input"
              >
                {t("bookMenu.editInfo")}
              </button>
              <button
                type="button"
                onClick={() => setDeleting(true)}
                className="h-8 rounded-lg px-3 text-[12px] text-text-muted hover:bg-bg-input"
              >
                {t("bookMenu.deleteBook")}
              </button>
            </>
          )}
        </div>
      </header>

      <BottomSheet
        open={isNarrow && moreOpen}
        onClose={() => setMoreOpen(false)}
        title={t("bookDetails.moreActions")}
      >
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => { setMoreOpen(false); setEditing(true); }}
            className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-text-primary"
          >
            <Pencil size={18} className="text-text-muted" aria-hidden="true" />
            <span className="text-[15px]">{t("bookMenu.editInfo")}</span>
          </button>
          <button
            type="button"
            onClick={() => { setMoreOpen(false); setDeleting(true); }}
            className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-danger-text"
          >
            <Trash2 size={18} aria-hidden="true" />
            <span className="text-[15px]">{t("bookMenu.deleteBook")}</span>
          </button>
        </div>
      </BottomSheet>

      <div className="mx-auto w-full max-w-[1000px] px-4 py-5 md:px-7 md:py-6">
        <section className="grid grid-cols-[96px_1fr] gap-4 border-b border-border pb-5 md:grid-cols-[120px_1fr] md:gap-[22px] md:pb-[22px]">
          <div className="aspect-[3/4] w-full overflow-hidden rounded-md bg-bg-muted shadow-card md:w-[120px]">
            {book.cover_data ? (
              <img src={book.cover_data} alt="" className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center px-3 text-center text-[10px] leading-[1.35] text-text-muted">
                {book.title}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="mb-1.5 font-serif text-[21px] font-semibold leading-[1.25] md:text-[24px]">{book.title}</h1>
            <p className="text-[13px] text-text-secondary">{book.author}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-accent-bg px-2 py-[3px] text-[10.5px] text-accent-text">{statusLabel}</span>
              <span className="rounded-md border border-border px-2 py-[3px] text-[10.5px] text-text-muted">
                {(book.source_format ?? book.format).toUpperCase()}
              </span>
              <span className="rounded-md border border-border px-2 py-[3px] text-[10.5px] text-text-muted">
                {t("bookDetails.addedOn", { date: dateOnly.format(new Date(book.created_at)) })}
              </span>
            </div>
            <div className="mt-4 h-1 w-[min(420px,100%)] overflow-hidden rounded-full bg-bg-input">
              <div className="h-full rounded-full bg-accent/75" style={{ width: `${Math.min(100, Math.max(0, book.progress))}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-text-muted">
              {t("bookDetails.progressLine", { percent: Math.round(book.progress) })}
            </p>
          </div>
        </section>

        {/* Four numbers side by side is a desktop strip: at 390px each column
            would be ~83px for a 22px serif number and its label. Two rows of
            two instead — not a horizontal scroller, because a row of figures
            you have to swipe to finish is a row nobody finishes. The rules
            follow the shape: vertical between the pair, horizontal under the
            first row, and the wide layout gets its single strip back. */}
        <section className="grid grid-cols-2 border-b border-border py-2 md:grid-cols-4 md:py-4">
          {metrics.map(([value, label], index) => (
            <div key={label} className={metricCellClass(index)}>
              <strong className="block font-serif text-[22px] font-medium leading-[1.2]">{value}</strong>
              <span className="mt-1.5 block text-[10.5px] text-text-muted">{label}</span>
            </div>
          ))}
        </section>

        <CoverageSection
          bookId={book.id}
          bookTitle={book.title}
          onStartReading={() => requestOpen(book)}
        />

        <section className="mt-6" aria-labelledby="book-difficulty-heading">
          <div className="mb-3">
            <h2 id="book-difficulty-heading" className="text-[13.5px] font-semibold">{t("bookDifficulty.heading")}</h2>
            <p className="mt-1 text-[10.5px] text-text-muted">{t("bookDifficulty.description")}</p>
          </div>
          {/* 40px of side padding is affordable on a desktop card and is 11%
              of a phone's width, taken off the one section that has a table in
              it. The card keeps its inset on wide screens. */}
          <div className="rounded-[13px] border border-border px-3.5 py-[18px] md:px-5">
            <DifficultySection
              difficulty={difficulty}
              loading={loading}
              callError={callError}
              baseline={baseline}
              overrideOpen={overrideOpen}
              onToggleOverride={() => setOverrideOpen((open) => !open)}
              onCompute={() => void compute()}
              onSetOverride={(value) => void setOverride(value)}
            />
          </div>
        </section>

        <section className="mt-6" aria-labelledby="book-file-heading">
          <h2 id="book-file-heading" className="mb-3 text-[13.5px] font-semibold">{t("bookDetails.fileHeading")}</h2>
          <div className="border-t border-border-light">
            <FileRow label={t("bookDetails.fileFormat")} hint={t("bookDetails.fileFormatHint")} value={(book.source_format ?? book.format).toUpperCase()} />
            <FileRow label={t("bookDetails.fileAdded")} value={addedAt} />
            <FileRow label={t("bookDetails.fileName")} value={fileNameOf(book.file_path)} />
          </div>
        </section>
      </div>

      {editing ? (
        <EditMetadataModal
          bookId={book.id}
          currentTitle={book.title}
          currentAuthor={book.author}
          currentCover={book.cover_data}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); loadBook(); }}
        />
      ) : null}

      {deleting ? (
        <DeleteBookDialog
          title={book.title}
          onCancel={() => setDeleting(false)}
          onConfirm={remove}
        />
      ) : null}
    </main>
  );
}

function FileRow({ label, hint, value }: { label: string; hint?: string; value: string }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-4 border-b border-border-light py-2 md:gap-5">
      <span className="shrink-0 text-[12.5px]">
        {label}
        {hint ? <small className="mt-0.5 block text-[10.5px] text-text-muted">{hint}</small> : null}
      </span>
      {/* A file name is one long unbreakable token as far as the layout is
          concerned, and a flex item will not shrink below its own min-content.
          Without the break it pushes the row past the viewport on a phone. */}
      <span className="min-w-0 break-all text-right text-[12px] tabular-nums text-text-secondary">{value}</span>
    </div>
  );
}

/**
 * One dot, one heading, one paragraph, and at most two buttons. Every state
 * that is not a distribution reduces to this: what happened, and what can be
 * done about it. No apology, and nothing that asks the reader to come back.
 */
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

function DifficultySection({
  difficulty,
  loading,
  callError,
  baseline,
  overrideOpen,
  onToggleOverride,
  onCompute,
  onSetOverride,
}: {
  difficulty: BookDifficulty | null;
  loading: boolean;
  callError: string | null;
  baseline: { value: number | null; books: number };
  overrideOpen: boolean;
  onToggleOverride(): void;
  onCompute(): void;
  onSetOverride(value: BookDifficultyOverride | null): void;
}) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const stampFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
    [i18n.language],
  );

  if (loading && !difficulty) return <div className="h-14" />;

  if (!difficulty) {
    return (
      <StateNote tone="bad" heading={t("bookDifficulty.unavailable")} body={callError ?? t("bookDifficulty.unavailableBody")} />
    );
  }

  if (difficulty.status === "pending") {
    return (
      <StateNote tone="idle" heading={t("bookDifficulty.pending.heading")} body={t("bookDifficulty.pending.body")}>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onCompute}
            className="h-8 rounded-lg border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input"
          >
            {t("bookDifficulty.computeNow")}
          </button>
          <span className="text-[10.5px] text-text-muted">{t("bookDifficulty.pending.cost")}</span>
        </div>
      </StateNote>
    );
  }

  if (difficulty.status === "running") {
    return (
      <StateNote tone="running" heading={t("bookDifficulty.running.heading")} body={t("bookDifficulty.running.body")}>
        {/* The backend reports completion, not progress, so this bar tells the
            truth by not pretending to know a fraction. */}
        <div className="mt-3.5 h-[3px] w-[min(420px,100%)] overflow-hidden rounded-full bg-bg-input" role="progressbar" aria-valuetext={t("bookDifficulty.running.heading")}>
          <div className="difficulty-scan h-full w-1/3 rounded-full bg-accent/75" />
        </div>
      </StateNote>
    );
  }

  if (difficulty.status === "failed") {
    return (
      <StateNote
        tone="bad"
        heading={t("bookDifficulty.failed.heading")}
        body={difficulty.error ?? t("bookDifficulty.failed.body")}
      >
        <div className="mt-3">
          <button
            type="button"
            onClick={onCompute}
            className="h-8 rounded-lg border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input"
          >
            {t("bookDifficulty.retry")}
          </button>
        </div>
      </StateNote>
    );
  }

  const share = hardShare(difficulty);
  const auto: DifficultyVerdict = difficulty.status === "done"
    ? difficultyVerdict(share, baseline.value)
    : "unclear";
  const shown = effectiveVerdict(auto, difficulty.override);
  const slices = bandSlices(difficulty);
  const hasDistribution = difficulty.totalTokens > 0;
  // A permanent "no conclusion" never offers to run again: neither a short
  // file nor an unreadable format changes by being asked twice. A changed
  // file is the one thing that does, and that is what `stale` reports.
  const permanent = difficulty.status === "too_short" || difficulty.status === "unsupported";
  // A short file is only worth recounting if it stopped being short, and a
  // format that yields no text is never worth recounting at all. So the quiet
  // footer link belongs to a finished count, while the stale strip belongs to
  // any status whose source file could still change.
  const offerRecompute = difficulty.status === "done";
  const offerStaleRecompute = difficulty.stale && difficulty.status !== "unsupported";

  // The reader's own verdict wins the sentence outright, including on a book
  // the analysis could not conclude anything about — "I read it, it was fine"
  // is a better answer than "the file was too short" and they are the one who
  // read it.
  const verdictLine = shown === "hidden"
    ? null
    : difficulty.override !== null
      ? t(`bookDifficulty.line.${shown}`, { verdict: markEmphasis(t(`bookDifficulty.word.${shown}`)) })
      : difficulty.status === "unsupported"
        ? t("bookDifficulty.line.unsupported", { verdict: markEmphasis(t("bookDifficulty.word.unclear")) })
        : difficulty.status === "too_short"
          ? t("bookDifficulty.line.tooShort", { verdict: markEmphasis(t("bookDifficulty.word.unclear")) })
          : t(`bookDifficulty.line.${shown}`, { verdict: markEmphasis(t(`bookDifficulty.word.${shown}`)) });

  const why = difficulty.status === "unsupported"
    ? t("bookDifficulty.why.unsupported")
    : difficulty.status === "too_short"
      ? t("bookDifficulty.why.tooShort", {
        tokens: markEmphasis(numbers.format(difficulty.totalTokens)),
        floor: markEmphasis(numbers.format(5000)),
      })
      : auto === "unclear"
        ? t("bookDifficulty.why.unclear", {
          hard: markEmphasis(`${formatShare(share)}%`),
          min: MIN_BASELINE_BOOKS,
        })
        : auto === "easier"
          ? t("bookDifficulty.why.easier", {
            easy: markEmphasis(`${formatShare(easyShare(difficulty))}%`),
            hard: markEmphasis(`${formatShare(share)}%`),
          })
          : t(`bookDifficulty.why.${auto}`, {
            hard: markEmphasis(`${formatShare(share)}%`),
            baseline: markEmphasis(`${formatShare(baseline.value ?? 0)}%`),
            count: baseline.books,
          });

  return (
    <>
      {/* Same stacking as the coverage card: the verdict keeps the width, the
          provenance stamp drops under it on a phone. */}
      <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:gap-6">
        <div className="min-w-0">
          {verdictLine ? (
            <p className={`m-0 font-serif text-[19px] leading-[1.6] ${permanent ? "text-text-secondary" : ""}`}>
              {splitEmphasis(verdictLine).map((part, index) => (
                part.emphasis
                  ? <strong key={index} className={`font-semibold ${permanent ? "text-text-secondary" : "text-accent-text"}`}>{part.text}</strong>
                  : <span key={index}>{part.text}</span>
              ))}
            </p>
          ) : (
            <p className="m-0 font-serif text-[19px] leading-[1.6] text-text-muted">{t("bookDifficulty.override.hiddenLine")}</p>
          )}
          {shown === "hidden" ? null : (
            <p className="mt-2.5 max-w-[560px] text-[11.5px] leading-[1.8] text-text-secondary">
              {splitEmphasis(why).map((part, index) => (
                part.emphasis
                  ? <strong key={index} className="font-semibold text-text-primary">{part.text}</strong>
                  : <span key={index}>{part.text}</span>
              ))}
            </p>
          )}
          {/* The automatic verdict does not go away when the reader writes
              over it. It sits underneath, in plain sight, because an
              annotation that erases what it annotates is not an annotation. */}
          {difficulty.override !== null ? (
            <p className="mt-2.5 max-w-[560px] text-[10.5px] leading-[1.8] text-text-muted">
              {permanent
                ? t("bookDifficulty.override.autoNoteUnavailable")
                : t("bookDifficulty.override.autoNote", { verdict: t(`bookDifficulty.word.${auto}`) })}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-[10px] leading-[1.7] text-text-muted md:text-right">
          {difficulty.computedAt ? (
            <strong className="block text-[11px] font-semibold text-text-secondary">
              {t("bookDifficulty.stamp.computedAt", { date: stampFormat.format(new Date(difficulty.computedAt)) })}
            </strong>
          ) : null}
          {hasDistribution ? (
            <>
              <span className="block">{t("bookDifficulty.stamp.sample", { tokens: numbers.format(difficulty.totalTokens) })}</span>
              <span className="block">{t("bookDifficulty.stamp.distinct", { words: numbers.format(difficulty.distinctWords) })}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* The file changed under numbers that are still on screen. They stay
          readable — they were true of the file they were computed from — and
          nothing recomputes on its own. */}
      {offerStaleRecompute ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-muted px-3.5 py-3">
          <p className="m-0 max-w-[560px] text-[11px] leading-[1.7] text-text-secondary">{t("bookDifficulty.stale.body")}</p>
          <button
            type="button"
            onClick={onCompute}
            className="h-8 shrink-0 rounded-lg bg-accent px-3 text-[12px] font-medium text-white touch:h-11 touch:px-4 touch:text-[13px]"
          >
            {t("bookDifficulty.recompute")}
          </button>
        </div>
      ) : null}

      {hasDistribution ? (
        <>
          <div className="mt-5 flex h-4 overflow-hidden rounded-[5px] bg-bg-input" role="img" aria-label={t("bookDifficulty.barLabel")}>
            {slices.map((slice) => (
              <div
                key={slice.band ?? "unlisted"}
                className="relative grid h-full place-items-center overflow-hidden whitespace-nowrap"
                style={{ width: `${slice.share * 100}%`, background: slice.color }}
              >
                {slice.share >= 0.12 ? (
                  <span className="text-[9.5px] font-semibold tracking-[0.02em] text-text-secondary">
                    {slice.band === null
                      ? t("bookDifficulty.bandUnlisted")
                      : t("bookDifficulty.bandName", { band: slice.band })}
                    {" "}
                    {formatShare(slice.share)}%
                  </span>
                ) : slice.share >= 0.06 ? (
                  <span className="text-[9.5px] font-semibold tracking-[0.02em] text-text-secondary">
                    {formatShare(slice.share)}%
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[9.5px] text-text-muted">
            <span>{t("bookDifficulty.axisCommon")}</span>
            <span>{t("bookDifficulty.axisRare")}</span>
          </div>

          {/* Three columns need 190 + 118 + 74 + gaps ≈ 410px, which a phone
              does not have. Rather than drop a column — every one of them is
              load-bearing for "why is this book hard" — each row folds into
              two lines: band and share on top, the rank range under the band,
              with the share spanning both. Same DOM either way; only the cells'
              placement changes, so nothing is duplicated or hidden. */}
          <div className="mt-4 border-t border-border-light">
            <div className="hidden grid-cols-[minmax(190px,1.15fr)_118px_74px] items-center gap-3.5 border-b border-border-light px-0.5 py-[7px] text-[10px] tracking-[0.04em] text-text-muted md:grid">
              <span>{t("bookDifficulty.columnBand")}</span>
              <span>{t("bookDifficulty.columnRank")}</span>
              <span className="text-right">{t("bookDifficulty.columnShare")}</span>
            </div>
            {slices.map((slice) => (
              <div
                key={slice.band ?? "unlisted"}
                className="grid grid-cols-[1fr_auto] items-center gap-x-3.5 gap-y-1 border-b border-border-light px-0.5 py-[11px] md:grid-cols-[minmax(190px,1.15fr)_118px_74px] md:gap-y-0"
              >
                <span className="col-start-1 row-start-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[12px] md:items-center">
                  <i className="size-2.5 shrink-0 self-center rounded-[3px]" style={{ background: slice.color }} aria-hidden="true" />
                  {slice.band === null ? t("bookDifficulty.bandUnlisted") : t("bookDifficulty.bandName", { band: slice.band })}
                  <small className="text-[10.5px] font-normal text-text-muted">
                    {slice.band === null ? t("bookDifficulty.bandUnlistedHint") : t(`bookDifficulty.bandHint.${slice.band}`)}
                  </small>
                </span>
                <span className="col-start-1 row-start-2 text-[10.5px] tabular-nums text-text-muted md:col-start-2 md:row-start-1">
                  {slice.from === null
                    ? "—"
                    : slice.to === null
                      ? t("bookDifficulty.rankFrom", { from: numbers.format(slice.from) })
                      : t("bookDifficulty.rankRange", { from: numbers.format(slice.from), to: numbers.format(slice.to) })}
                </span>
                <span className={`col-start-2 row-span-2 row-start-1 self-center text-right font-serif text-[14px] font-medium tabular-nums md:col-start-3 md:row-span-1 ${slice.band === null ? "text-text-muted" : ""}`}>
                  {formatShare(slice.share)}%
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-5 border-t border-border pt-3">
        <p className="m-0 max-w-[620px] text-[10.5px] leading-[1.8] text-text-muted">
          {t("bookDifficulty.source")}
          {difficulty.status === "too_short" ? ` ${t("bookDifficulty.tooShortFooter")}` : ""}
          {difficulty.status === "unsupported" ? ` ${t("bookDifficulty.unsupportedFooter")}` : ""}
        </p>
        {/* Two links, not two buttons — but a link you press is still a target,
            and at 11px these are about 60×15. Under a finger they get the 44px
            height without the border or fill that would make them read as
            buttons; the type stays small so the footnote above still reads as
            the primary text of the row. */}
        <span className="flex shrink-0 gap-4 touch:-my-3">
          <button
            type="button"
            onClick={onToggleOverride}
            className="text-[11px] whitespace-nowrap text-accent-text touch:inline-flex touch:min-h-11 touch:items-center"
          >
            {t("bookDifficulty.override.open")}
          </button>
          {offerRecompute && !offerStaleRecompute ? (
            <button
              type="button"
              onClick={onCompute}
              className="text-[11px] whitespace-nowrap text-accent-text touch:inline-flex touch:min-h-11 touch:items-center"
            >
              {t("bookDifficulty.recompute")}
            </button>
          ) : null}
        </span>
      </div>

      {overrideOpen ? (
        <OverridePanel
          value={difficulty.override}
          auto={auto}
          permanent={permanent}
          onSetOverride={onSetOverride}
        />
      ) : null}
    </>
  );
}

/**
 * The reader's own verdict, expanded in place rather than in a dialog.
 *
 * It replaces the sentence and nothing else. The automatic verdict stays
 * written underneath — visible, and one press from being restored — because
 * this is an annotation on a measurement, not a correction of one. The
 * distribution below is untouched either way: it is a count, not an opinion.
 */
function OverridePanel({
  value,
  auto,
  permanent,
  onSetOverride,
}: {
  value: BookDifficultyOverride | null;
  auto: DifficultyVerdict;
  permanent: boolean;
  onSetOverride(next: BookDifficultyOverride | null): void;
}) {
  const { t } = useTranslation();
  const choices: BookDifficultyOverride[] = ["easier", "matched", "harder", "hidden"];

  return (
    <div className="mt-4 rounded-[11px] border border-border bg-bg-muted px-4 py-[15px]">
      <h4 className="m-0 text-[12px] font-semibold">{t("bookDifficulty.override.open")}</h4>
      <p className="mt-1.5 text-[10.5px] leading-[1.75] text-text-muted">{t("bookDifficulty.override.body")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {choices.map((choice) => {
          const active = value === choice;
          return (
            <button
              key={choice}
              type="button"
              aria-pressed={active}
              onClick={() => onSetOverride(active ? null : choice)}
              className={`h-[30px] rounded-lg border px-3 text-[11.5px] touch:h-11 touch:px-3.5 touch:text-[13px] ${
                active
                  ? "border-accent font-semibold text-accent-text"
                  : choice === "hidden"
                    ? "border-border bg-bg-surface text-text-muted"
                    : "border-border bg-bg-surface text-text-secondary"
              }`}
            >
              {t(`bookDifficulty.override.choice.${choice}`)}
            </button>
          );
        })}
      </div>
      {value ? (
        <p className="mt-3 text-[10.5px] leading-[1.75] text-text-muted">
          {t("bookDifficulty.override.current", { choice: t(`bookDifficulty.override.choice.${value}`) })}
          {" · "}
          {permanent
            ? t("bookDifficulty.override.autoUnavailable")
            : t("bookDifficulty.override.auto", { verdict: t(`bookDifficulty.word.${auto}`) })}
          {" · "}
          <button type="button" onClick={() => onSetOverride(null)} className="text-accent-text">
            {t("bookDifficulty.override.revert")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
