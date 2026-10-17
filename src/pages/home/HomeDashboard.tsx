import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { BarChart3, BookA, GraduationCap, Plus, Search, Sparkles } from "lucide-react";
import type { Book } from "../../hooks/useBooks";
import type { LookupRecord } from "../../hooks/useDictionary";
import { useOpenBook } from "../../hooks/useOpenBook";
import { useReadingPace } from "../../hooks/useOpenCardData";
import { useBookDifficulty } from "../../hooks/useBookDifficulty";
import { openCommandPalette } from "../../components/library-actions";
import { platform } from "../../services/platform";
import {
  greetingFor,
  lastReadOf,
  lastSevenDays,
  latestChapterWords,
  minutesLeft,
  secondsPerDay,
  splitDuration,
} from "./home-dashboard-model";

interface HomeDashboardProps {
  userName: string;
  dueForReviewCount: number;
  /** Bumped by the page whenever the library changes, so the hero re-reads. */
  refreshKey: number;
  onImport: () => void;
  onReview: () => void;
  onOpenFilter: (filter: string) => void;
}

interface WeekNumbers {
  perDay: number[];
  totalSeconds: number;
  newWords: number;
  lookups: number;
}

/**
 * The top of the library: a greeting, the book you were reading, and today
 * (design v2 §5, 「首页 = 接着读」; canvas board 「v2 首页」). Everything below
 * it is the shelf, which `Home` still owns.
 *
 * Desktop only, like the rail: on a phone the shelf header keeps its own row.
 */
export default function HomeDashboard({ userName, dueForReviewCount, refreshKey, onImport, onReview, onOpenFilter }: HomeDashboardProps) {
  const { t, i18n } = useTranslation();
  const [now] = useState(() => new Date());
  const [book, setBook] = useState<Book | null>(null);
  const [week, setWeek] = useState<WeekNumbers | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<{ books: Book[] }>("list_books", {
      filter: "reading",
      search: null,
      collectionId: null,
      cursor: null,
      limit: 1,
      sort: "recent",
    })
      .then((page) => { if (alive) setBook(page.books[0] ?? null); })
      .catch(() => { if (alive) setBook(null); });
    return () => { alive = false; };
  }, [refreshKey]);

  useEffect(() => {
    let alive = true;
    const { start, end, days } = lastSevenDays(new Date());
    const query = { periodStart: start, periodEnd: end, scopeBookId: null, timezoneOffsetMinutes: new Date().getTimezoneOffset() };
    Promise.all([
      invoke<{ calendar: Array<{ date: string; activeSeconds: number }>; overview: { totalActiveSeconds: number } }>("get_reading_stats_dashboard", { query }),
      invoke<{ newWordsCount: number; lookupCount: number }>("get_vocab_learning_dashboard", { query }).catch(() => null),
    ])
      .then(([reading, learning]) => {
        if (!alive) return;
        const perDay = secondsPerDay(reading.calendar ?? [], days);
        setWeek({
          perDay,
          totalSeconds: perDay.reduce((sum, s) => sum + s, 0),
          newWords: learning?.newWordsCount ?? 0,
          lookups: learning?.lookupCount ?? 0,
        });
      })
      .catch(() => { if (alive) setWeek(null); });
    return () => { alive = false; };
  }, [refreshKey]);

  const greeting = t(`home.greeting.${greetingFor(now.getHours())}`);
  const date = new Intl.DateTimeFormat(i18n.language, { month: "long", day: "numeric", weekday: "short" }).format(now);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate font-serif text-[24px] font-semibold tracking-[0.01em] text-text-primary">
            {userName ? t("home.greeting.withName", { greeting, name: userName }) : greeting}
          </h1>
          <span className="shrink-0 text-[12.5px] text-text-muted">{date}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex h-9 w-[260px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg-surface px-3 text-left text-[13px] text-text-muted transition-colors duration-[var(--motion-instant)] hover:border-text-muted/40"
          >
            <Search size={14} className="shrink-0" />
            <span className="flex-1 truncate">{t("palette.placeholder")}</span>
            <kbd className="rounded border border-border bg-bg-page px-1.5 font-sans text-[10.5px] text-text-muted">
              {platform.id === "macos" ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
          <button
            type="button"
            onClick={onImport}
            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors duration-[var(--motion-instant)] hover:bg-accent-hover"
          >
            <Plus size={14} strokeWidth={2.4} />
            {t("home.import")}
          </button>
        </div>
      </header>

      {book && <ContinueCard book={book} now={now} />}

      <section aria-label={t("home.today.label")} className="grid grid-cols-3 gap-3">
        <TodayTile
          icon={<GraduationCap size={16} />}
          onClick={onReview}
          title={dueForReviewCount > 0 ? t("home.today.due", { count: dueForReviewCount }) : t("home.today.noneDue")}
          detail={dueForReviewCount > 0 ? t("home.today.dueAction") : t("home.today.noneDueDetail")}
          accent={dueForReviewCount > 0}
        />
        <TodayTile
          icon={<BarChart3 size={16} />}
          onClick={() => onOpenFilter("stats")}
          title={week ? weekTitle(t, week.totalSeconds) : "—"}
          detail={week ? <WeekBars perDay={week.perDay} label={t("home.today.weekBars")} /> : null}
        />
        <TodayTile
          icon={<BookA size={16} />}
          onClick={() => onOpenFilter("vocab")}
          title={week ? t("home.today.words", { count: week.newWords }) : "—"}
          detail={week ? t("home.today.lookups", { count: week.lookups }) : null}
        />
      </section>
    </div>
  );
}

function weekTitle(t: (key: string, options?: Record<string, unknown>) => string, seconds: number): string {
  const { hours, minutes } = splitDuration(seconds);
  if (hours === 0 && minutes === 0) return t("home.today.weekNone");
  if (hours === 0) return t("home.today.weekMinutes", { minutes });
  return minutes === 0 ? t("home.today.weekHoursOnly", { hours }) : t("home.today.weekHours", { hours, minutes });
}

function ContinueCard({ book, now }: { book: Book; now: Date }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openInReader = useOpenBook();
  const pace = useReadingPace(book.id);
  const { difficulty } = useBookDifficulty(book.id);
  const [chapterWords, setChapterWords] = useState<ReturnType<typeof latestChapterWords>>(null);

  useEffect(() => {
    let alive = true;
    // The newest page only: the chapter comes from the newest lookup, and its
    // words are the ones looked up last.
    invoke<{ records: LookupRecord[] }>("list_all_lookup_records", { search: null, bookId: book.id, cursor: null, limit: 40 })
      .then((page) => { if (alive) setChapterWords(latestChapterWords(page.records)); })
      .catch(() => { if (alive) setChapterWords(null); });
    return () => { alive = false; };
  }, [book.id]);

  const progress = Math.round(book.progress);
  const left = minutesLeft(
    difficulty?.totalTokens,
    book.progress,
    pace.value?.bookWordsPerMinute ?? pace.value?.overallWordsPerMinute,
  );
  const leftLabel = left === null
    ? null
    : left >= 60
      ? t("home.continue.leftHours", { hours: Math.floor(left / 60), minutes: left % 60 })
      : t("home.continue.leftMinutes", { minutes: left });
  const lastRead = lastReadOf(book.updated_at, now);
  const lastReadLabel = lastRead.kind === "daysAgo"
    ? t("home.continue.daysAgo", { count: lastRead.days })
    : t(`home.continue.${lastRead.kind}`);
  const resume = () => openInReader(book.id, { cfi: book.current_cfi });

  return (
    <section
      aria-label={t("home.continue.label")}
      className="flex overflow-hidden rounded-2xl border border-border-light bg-bg-surface shadow-card"
    >
      <div className="flex min-w-0 flex-1 items-center gap-5 px-6 py-5">
        <button
          type="button"
          onClick={resume}
          aria-label={t("home.continue.resumeBook", { title: book.title })}
          className="book-cover relative h-[134px] w-[96px] shrink-0 cursor-pointer overflow-hidden rounded-[3px_8px_8px_3px] bg-bg-muted shadow-card"
        >
          {book.cover_data ? (
            <img src={book.cover_data} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-end p-2.5 text-left font-serif text-[12px] leading-tight text-text-secondary">{book.title}</span>
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-accent-text">
            {t("home.continue.eyebrow", { when: lastReadLabel })}
          </div>
          <div className="truncate font-serif text-[22px] font-semibold leading-tight text-text-primary">{book.title}</div>
          <div className="truncate text-[12.5px] text-text-secondary">
            {[book.author, chapterWords?.chapter].filter(Boolean).join(" · ")}
          </div>
          <div className="mt-0.5 flex items-center gap-2.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-input">
              <div className="h-full rounded-full bg-accent transition-[width] duration-[var(--motion-base)]" style={{ width: `${progress}%` }} />
            </div>
            <span className="shrink-0 text-[11.5px] tabular-nums text-text-secondary">
              {leftLabel ? `${progress}% · ${leftLabel}` : `${progress}%`}
            </span>
          </div>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={resume}
              className="h-[34px] cursor-pointer rounded-[9px] bg-text-primary px-4 text-[13px] font-semibold text-bg-page transition-opacity duration-[var(--motion-instant)] hover:opacity-90"
            >
              {t("home.continue.resume")}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/book/${book.id}`)}
              className="h-[34px] cursor-pointer rounded-[9px] border border-border px-3.5 text-[13px] text-text-secondary transition-colors duration-[var(--motion-instant)] hover:bg-bg-input"
            >
              {t("home.continue.bookPage")}
            </button>
          </div>
        </div>
      </div>
      {chapterWords && chapterWords.words.length > 0 && (
        <aside
          aria-label={t("home.continue.chapterLabel")}
          className="flex w-[320px] shrink-0 flex-col gap-2 border-l border-border-light bg-bg-page px-5 py-5"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-text-muted">
            <Sparkles size={12} className="text-accent" />
            {t("home.continue.chapterLabel")}
          </div>
          <p className="line-clamp-2 font-serif text-[14px] leading-snug text-text-primary">{chapterWords.chapter}</p>
          <div className="mt-auto flex flex-wrap gap-1.5">
            {chapterWords.words.map((word) => (
              <span key={word} className="rounded-full border border-border bg-bg-surface px-2 py-0.5 font-serif text-[12px] text-text-secondary">
                {word}
              </span>
            ))}
          </div>
        </aside>
      )}
    </section>
  );
}

function TodayTile({ icon, title, detail, onClick, accent = false }: {
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border-light bg-bg-surface px-4 py-3.5 text-left transition-colors duration-[var(--motion-instant)] hover:border-border"
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${accent ? "bg-accent-bg text-accent-text" : "bg-bg-muted text-text-muted"}`}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[13.5px] font-semibold text-text-primary">{title}</span>
        {typeof detail === "string" ? <span className="truncate text-[11.5px] text-text-muted">{detail}</span> : detail}
      </span>
    </button>
  );
}

function WeekBars({ perDay, label }: { perDay: number[]; label: string }) {
  const max = Math.max(...perDay, 1);
  return (
    <span role="img" aria-label={label} className="flex h-5 items-end gap-[3px]">
      {perDay.map((seconds, index) => (
        <span
          key={index}
          className={`w-2 rounded-[2px] ${index === perDay.length - 1 ? "bg-accent" : "bg-text-muted/35"}`}
          style={{ height: `${Math.max(2, Math.round((seconds / max) * 20))}px` }}
        />
      ))}
    </span>
  );
}
