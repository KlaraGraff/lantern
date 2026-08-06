import { invoke } from "@tauri-apps/api/core";
import type {
  AutoReviewOffer,
  CachedReadingReview,
  ReadingReviewErrorCode,
  ReadingStatsAdapter,
  ReadingStatsDashboard,
  ReadingStatsQuery,
  ReadingStatsRange,
} from "./types";
import { ReadingReviewError } from "./types";

type BackendQuery = {
  periodStart: number;
  periodEnd: number;
  scopeBookId: string | null;
  timezoneOffsetMinutes: number;
};

type BackendDashboard = {
  overview: ReadingStatsDashboard["overview"];
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    totalActiveSeconds: number;
    sessionCount: number;
    readingDays: number;
    lastReadAt: number;
    completed: boolean;
    progress: number;
  }>;
  calendar: Array<{
    date: string;
    activeSeconds: number;
    sessionCount: number;
    booksTouched: number;
    sessions: Array<{ sessionId: string; bookId: string; title: string; startedAt: number; endedAt: number; activeSeconds: number }>;
  }>;
  facts: ReadingStatsDashboard["facts"];
  cachedReview: null | { narrative: string; providerProfileId: string; provider: string; model: string; updatedAt: number; facts: ReadingStatsDashboard["facts"] };
};

function rangeBounds(range: ReadingStatsRange, now = new Date()): [number, number] {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  if (range === "last30Days") return [new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime(), end];
  if (range === "year") return [new Date(now.getFullYear(), 0, 1).getTime(), end];
  return [Date.UTC(2000, 0, 1), end];
}

export function toBackendQuery(query: ReadingStatsQuery): BackendQuery {
  const [periodStart, periodEnd] = rangeBounds(query.range);
  return {
    periodStart,
    periodEnd,
    scopeBookId: query.bookId,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
  };
}

function normalizeDashboard(value: BackendDashboard): ReadingStatsDashboard {
  return {
    overview: value.overview,
    books: value.books.map((book) => ({
      bookId: book.bookId,
      title: book.title,
      author: book.author || null,
      coverData: null,
      progress: Math.max(0, Math.min(1, book.progress / 100)),
      completed: book.completed,
      activeSeconds: book.totalActiveSeconds,
      sessionCount: book.sessionCount,
    })),
    calendar: value.calendar.map((day) => ({
      date: day.date,
      activeSeconds: day.activeSeconds,
      sessions: day.sessions.map((session) => ({
        bookId: session.bookId,
        title: session.title,
        startedAt: Math.floor(session.startedAt / 1000),
        endedAt: Math.floor(session.endedAt / 1000),
        activeSeconds: session.activeSeconds,
      })),
    })),
    facts: value.facts,
    cachedReview: value.cachedReview ? {
      narrative: value.cachedReview.narrative,
      providerName: value.cachedReview.provider,
      model: value.cachedReview.model,
      updatedAt: Math.floor(value.cachedReview.updatedAt / 1000),
      facts: value.cachedReview.facts,
    } : null,
  };
}

function errorCode(error: unknown): ReadingReviewErrorCode {
  const text = String(error).toLowerCase();
  if (text.includes("not_configured") || text.includes("no_usable_keys")) return "notConfigured";
  if (text.includes("quota") || text.includes("402") || text.includes("insufficient")) return "quotaExceeded";
  if (text.includes("offline") || text.includes("network") || text.includes("timeout")) return "offline";
  return "failed";
}

/**
 * The one automatic job this page owns a manual button for. It is the same
 * string the backend registry uses and the same string the call is tagged
 * with in `ai_usage_records.feature` — one name, or the switch and the bill
 * stop describing the same thing.
 */
const REVIEW_JOB = "reading_review";

type JobView = {
  id: string;
  recommendAuto: boolean;
  typicalTokens: number | null;
  manualRuns: number;
};

function offerOf(view: JobView): AutoReviewOffer {
  return {
    recommend: view.recommendAuto,
    typicalTokens: view.typicalTokens,
    manualRuns: view.manualRuns,
  };
}

const NO_OFFER: AutoReviewOffer = { recommend: false, typicalTokens: null, manualRuns: 0 };

export function createTauriReadingStatsAdapter(language = "en"): ReadingStatsAdapter {
  return {
    async autoReviewOffer() {
      // Every one of these swallows its error into "no offer". Nothing here
      // is something the reader asked for, so nothing here has earned the
      // right to put a failure on their screen.
      try {
        const console_ = await invoke<{ jobs: JobView[] }>("auto_analysis_console", { sinceMs: 0 });
        const view = console_.jobs.find((job) => job.id === REVIEW_JOB);
        return view ? offerOf(view) : NO_OFFER;
      } catch {
        return NO_OFFER;
      }
    },
    async noteManualReview() {
      try {
        return offerOf(await invoke<JobView>("note_manual_analysis_run", { jobId: REVIEW_JOB }));
      } catch {
        return NO_OFFER;
      }
    },
    async acceptAutoReview() {
      try {
        return offerOf(
          await invoke<JobView>("set_auto_analysis_enabled", { jobId: REVIEW_JOB, enabled: true }),
        );
      } catch {
        return NO_OFFER;
      }
    },
    async declineAutoReview() {
      try {
        return offerOf(
          await invoke<JobView>("dismiss_auto_analysis_recommendation", { jobId: REVIEW_JOB }),
        );
      } catch {
        return NO_OFFER;
      }
    },
    async loadDashboard(query) {
      const backendQuery = toBackendQuery(query);
      const value = await invoke<BackendDashboard>("get_reading_stats_dashboard", { query: backendQuery });
      return normalizeDashboard(value);
    },
    async generateReview(query) {
      try {
        const backendQuery = toBackendQuery(query);
        const generated = await invoke<{ narrative: string; facts: CachedReadingReview["facts"]; providerProfileId: string; provider: string; model: string; updatedAt: number }>("generate_reading_review", {
          query: backendQuery,
          language,
          retry: false,
          requestId: null,
        });
        return {
          narrative: generated.narrative,
          providerName: generated.provider,
          model: generated.model,
          updatedAt: Math.floor(generated.updatedAt / 1000),
          facts: generated.facts,
        };
      } catch (error) {
        throw new ReadingReviewError(errorCode(error), String(error));
      }
    },
  };
}

export function readingSessionRecordPayload(input: {
  bookId: string;
  startedAt: number;
  endedAt: number;
  activeSeconds: number;
}): { bookId: string; startedAt: number; endedAt: number; activeSeconds: number } {
  return input;
}
