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
/**
 * What the page needs to know about making this review automatic.
 *
 * `recommend` is the backend's whole decision — the page never re-derives
 * it. `typicalTokens` is what one run has actually cost, or null when
 * nothing has run yet; the offer states the price or says nothing, it never
 * estimates.
 */
export interface AutoReviewOffer {
  recommend: boolean;
  typicalTokens: number | null;
  /**
   * How many times the reader has done this by hand. The offer quotes the
   * real count rather than the threshold that unlocked it — by the time
   * someone is on their sixth run, telling them "you've done this 4 times"
   * is a script, not an observation.
   */
  manualRuns: number;
}

export interface ReadingStatsAdapter {
  loadDashboard(query: ReadingStatsQuery): Promise<ReadingStatsDashboard>;
  generateReview(query: ReadingStatsQuery): Promise<CachedReadingReview>;
  /** The offer as it stands, without changing anything. */
  autoReviewOffer?(): Promise<AutoReviewOffer>;
  /** Records one run by hand and returns the offer that results from it. */
  noteManualReview?(): Promise<AutoReviewOffer>;
  /** The reader said yes: the job runs on its own from now on. */
  acceptAutoReview?(): Promise<AutoReviewOffer>;
  /** The reader said no. One refusal settles it — this is never asked again. */
  declineAutoReview?(): Promise<AutoReviewOffer>;
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
  autoOfferTitle(manualRuns: number): string;
  autoOfferBody: string;
  autoOfferBodyWithCost(tokens: number): string;
  autoOfferAccept: string;
  autoOfferDecline: string;
  progressLabel: string;
  sessionCountLabel: (count: number) => string;
  formatDuration: (seconds: number) => string;
  formatDate: (isoDate: string) => string;
  formatTime: (timestampSeconds: number) => string;
  formatReviewUpdatedAt: (timestampSeconds: number) => string;
}
