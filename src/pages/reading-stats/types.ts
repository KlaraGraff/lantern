export type ReadingStatsView = "history" | "calendar";
export type ReadingStatsRange = "last30Days" | "year" | "all";

export interface ReadingStatsQuery {
  range: ReadingStatsRange;
  bookId: string | null;
}

export interface ReadingStatsOverview {
  totalActiveSeconds: number;
  booksTouched: number;
  completedBooks: number;
  sessionCount: number;
  readingDays: number;
}

export interface ReadingStatsBook {
  bookId: string;
  title: string;
  author: string | null;
  coverData: string | null;
  progress: number;
  completed: boolean;
  activeSeconds: number;
  sessionCount: number;
}

export interface ReadingStatsCalendarDay {
  date: string;
  activeSeconds: number;
  sessions: Array<{
    bookId: string;
    title: string;
    startedAt: number;
    endedAt: number;
    activeSeconds: number;
  }>;
}

export interface ReadingReviewFacts {
  periodStart: number;
  periodEnd: number;
  totalActiveSeconds: number;
  sessionCount: number;
  booksTouched: number;
  completedBooks: number;
  mostReadBookTitle: string | null;
  mostReadBookSeconds: number;
  readingDays: number;
  mostCommonHour: number | null;
}

export interface CachedReadingReview {
  narrative: string;
  providerName: string;
  model: string;
  updatedAt: number;
  facts: ReadingReviewFacts;
}

export interface ReadingStatsDashboard {
  overview: ReadingStatsOverview;
  books: ReadingStatsBook[];
  calendar: ReadingStatsCalendarDay[];
  facts: ReadingReviewFacts;
  cachedReview: CachedReadingReview | null;
}

export interface ReadingReviewProvider {
  name: string;
  model: string;
  billingNotice: string;
  configured: boolean;
}

export type ReadingReviewErrorCode = "notConfigured" | "quotaExceeded" | "offline" | "failed";

export class ReadingReviewError extends Error {
  readonly code: ReadingReviewErrorCode;

  constructor(code: ReadingReviewErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ReadingReviewError";
    this.code = code;
  }
}

/**
 * The shared integration pass supplies the command implementation. Keeping
 * this boundary explicit lets the page be tested without a live Tauri shell.
 */
export interface ReadingStatsAdapter {
  loadDashboard(query: ReadingStatsQuery): Promise<ReadingStatsDashboard>;
  generateReview(query: ReadingStatsQuery): Promise<CachedReadingReview>;
}

export interface ReadingStatsLabels {
  title: string;
  subtitleHistory: string;
  subtitleCalendar: string;
  loading: string;
  loadFailed: string;
  retry: string;
  allBooks: string;
  last30Days: string;
  thisYear: string;
  allTime: string;
  historyView: string;
  calendarView: string;
  focusedReading: string;
  booksRead: string;
  booksCompleted: string;
  validSessions: string;
  historyHeading: string;
  historyDescription: string;
  calendarHeading: string;
  calendarDescription: string;
  noCalendarActivity: string;
  noCalendarActivityDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyRule: string;
  privacyButton: string;
  privacyTitle: string;
  privacyDescription: string;
  privacyLocalFacts: string;
  privacyAiScope: string;
  privacyNoSocial: string;
  privacySessionRule: string;
  close: string;
  aiBadge: string;
  aiReviewHeading: string;
  aiReviewDescription: string;
  aiGenerate: string;
  aiRefresh: string;
  aiGenerating: string;
  aiGeneratedBy: string;
  aiDisclosureTitle: string;
  aiDisclosureDescription: string;
  aiDisclosureProvider: string;
  aiDisclosureData: string;
  aiDisclosureDataValue: string;
  aiDisclosureExcludes: string;
  aiDisclosureExcludesValue: string;
  aiDisclosureBilling: string;
  aiDisclosureConfirm: string;
  aiNotConfigured: string;
  aiQuotaExceeded: string;
  aiOffline: string;
  aiFailed: string;
  aiCachedNotice: string;
  progressLabel: string;
  sessionCountLabel: (count: number) => string;
  formatDuration: (seconds: number) => string;
  formatDate: (isoDate: string) => string;
  formatTime: (timestampSeconds: number) => string;
  formatReviewUpdatedAt: (timestampSeconds: number) => string;
}
