/**
 * Pure logic for the Book Open Card (`docs/impls/book-open-card-mockup.html`).
 * No React, no `invoke` — every function here takes plain data and returns a
 * plain answer, so the rules that decide what the card shows can be tested
 * without a database or a component tree.
 *
 * Reuses `hardShare`/`difficultyVerdict`/`VERDICT_MARGIN` from the book
 * details page's own difficulty view rather than duplicating them — both
 * pages read the same `book_difficulty` row and must agree on what "harder"
 * means.
 */
import type { Book } from "../hooks/useBooks";
import type { BookDifficulty, BookDifficultyStatus } from "../hooks/useBookDifficulty";
import type { BookDifficultySection } from "../hooks/useOpenCardData";
// Explicit extension: this module is exercised by node:test through
// `--experimental-strip-types`, which does no extensionless resolution.
import { VERDICT_MARGIN, difficultyVerdict } from "../pages/book-details/difficulty-view.ts";

/** The extraction layer's own signal for a scanned PDF (`extract_pdf`'s
 *  `is_scanned_pdf`, page_count > 5 && total_chars < 500), round-tripped
 *  losslessly through `AppError::Other` into `book_difficulty.error`
 *  (`src-tauri/src/ai/grounding/extract.rs`, `source.rs`). No frontend-side
 *  detection needed — the backend already tells us. */
const SCANNED_PDF_ERROR = "PDF_TEXT_LAYER_UNAVAILABLE";

export function isScannedPdf(
  book: Pick<Book, "format">,
  difficulty: Pick<BookDifficulty, "status" | "error"> | null,
): boolean {
  return (
    book.format === "pdf"
    && difficulty !== null
    && difficulty.status === "failed"
    && !!difficulty.error
    && difficulty.error.includes(SCANNED_PDF_ERROR)
  );
}

export type OpenSurface = "card" | "none";

export interface OpenSurfaceOptions {
  /** The Settings → Reading master toggle. */
  enabled: boolean;
  /** This one book's ✕ was pressed already this session. */
  sessionDismissed: boolean;
}

/**
 * What clicking this book's cover should do: show the full-screen card, or
 * go straight to the reader. The card is a first-open-only greeting — it
 * shows once, the moment a book stops being `"unread"`, and never again for
 * that book. A book that has already been opened once (`"reading"` or
 * `"finished"`) always goes straight to the reader: whoever wants this same
 * information back goes to the book's own Details page — "已经打开过的书想
 * 再看这些数字，去书籍详情页". No difficulty data is consulted here; that
 * information belongs to what the card shows once open (see
 * `classifyOpenCardBody`), not to whether it opens at all.
 */
export function openSurface(
  book: Pick<Book, "status">,
  options: OpenSurfaceOptions,
): OpenSurface {
  if (!options.enabled || options.sessionDismissed) return "none";
  return book.status === "unread" ? "card" : "none";
}

export type OpenCardBodyState =
  | "scanned"
  | "neverComputed"
  | "computing"
  | "noConclusion"
  | "insufficientRecord"
  | "ready";

/**
 * Which of the mockup's body states applies. Order matters: a scanned PDF's
 * `book_difficulty.status` is also literally `"failed"`, so the scanned
 * check must run before the generic no-conclusion one or every scanned PDF
 * would render as a plain, unexplained failure (§3, not §2c).
 *
 * `ocrAvailable` (default `true`, so existing callers/tests are unaffected)
 * is `platform.hasOcr` in practice: the OCR package/job commands this state's
 * offer depends on are compiled out on iOS/Android (D-003), so on those
 * platforms a scanned PDF must not classify as `"scanned"` at all — it falls
 * through to the plain `"noConclusion"` failure a step below, which already
 * says the book still reads normally and just has no difficulty figure,
 * instead of offering a download that can never complete.
 */
export function classifyOpenCardBody(
  book: Pick<Book, "format">,
  difficulty: BookDifficulty | null,
  passRatesSufficient: boolean,
  ocrAvailable: boolean = true,
): OpenCardBodyState {
  if (ocrAvailable && isScannedPdf(book, difficulty)) return "scanned";
  if (!difficulty || difficulty.status === "pending") return "neverComputed";
  if (difficulty.status === "running") return "computing";
  if (difficulty.status === "too_short" || difficulty.status === "unsupported" || difficulty.status === "failed") {
    return "noConclusion";
  }
  return passRatesSufficient ? "ready" : "insufficientRecord";
}

export type BandShares = readonly [number, number, number, number, number];
export type BandPassRates = readonly [number | null, number | null, number | null, number | null, number | null];

/** Each band's share of the book's total tokens (band count / totalTokens),
 *  index 0 is band 1. `[0,0,0,0,0]` for a book with no tokens counted yet. */
export function bandShares(
  difficulty: Pick<BookDifficulty, "band1" | "band2" | "band3" | "band4" | "band5" | "totalTokens">,
): BandShares {
  const total = difficulty.totalTokens;
  if (total <= 0) return [0, 0, 0, 0, 0];
  return [
    difficulty.band1 / total,
    difficulty.band2 / total,
    difficulty.band3 / total,
    difficulty.band4 / total,
    difficulty.band5 / total,
  ];
}

/**
 * Σ(band share × (1 − pass rate)) across bands 1–5 — the mockup §8 formula.
 * A band the reader has no evidence for (`null`) is treated as fully
 * unfamiliar rather than skipped: an undefined rate is not the same claim as
 * a zero one, but the card only has one number to show, and "no evidence
 * this was known" is the direction that does not overstate the reader.
 */
export function weightedHardShare(shares: BandShares, passRates: BandPassRates): number {
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    sum += shares[i] * (1 - (passRates[i] ?? 0));
  }
  return sum;
}

/** Whole-percent, "约"-prefixed rounding — the one rule every number on this
 *  card follows (mockup: "都用整数百分比，前面挂一个「约」"). */
export function roundPercent(share: number): number {
  return Math.round(share * 100);
}

export interface DisclosureRow {
  band: 1 | 2 | 3 | 4 | 5;
  bookSharePercent: number;
  /** `null` when the reader has no evidence for this band at all. */
  passRatePercent: number | null;
  contribution: number;
  /** This row's contribution relative to the largest one, 0–100. Purely for
   *  the disclosure table's relative bar — the mockup never draws an axis
   *  with units on it, only relative weight. */
  contributionWidthPercent: number;
}

export function disclosureRows(shares: BandShares, passRates: BandPassRates): DisclosureRow[] {
  const rows = ([1, 2, 3, 4, 5] as const).map((band) => {
    const share = shares[band - 1];
    const passRate = passRates[band - 1];
    const contribution = share * (1 - (passRate ?? 0));
    return {
      band,
      bookSharePercent: roundPercent(share),
      passRatePercent: passRate === null ? null : roundPercent(passRate),
      contribution,
    };
  });
  const max = Math.max(...rows.map((row) => row.contribution), 0.0001);
  return rows.map((row) => ({
    ...row,
    contributionWidthPercent: Math.round((row.contribution / max) * 100),
  }));
}

export type RidgeBarTier = "hi" | "mid" | "none";

export interface RidgeBar {
  sectionOrder: number;
  /** 24–100, the mockup's own bar-height range (never flat to zero — a
   *  section with the least hard words is still legible as a bar). */
  heightPercent: number;
  tier: RidgeBarTier;
  chapterTitle: string | null;
}

export type RidgeState =
  | { kind: "unavailable" }
  | { kind: "backfilling" }
  | { kind: "flat"; bars: RidgeBar[] }
  | { kind: "peak"; bars: RidgeBar[]; peakSectionOrder: number; peakTitle: string };

/**
 * The three-state (plus backfilling) "which chapter is hardest" block
 * (mockup §6). Three gates, in order: no usable per-section data at all
 * (PDF, or an old book still waiting on backfill); the peak isn't enough
 * above the median to call out (flat sentence instead); the peak section
 * has no chapter title that maps onto the book's own table of contents (the
 * whole block is dropped rather than naming a machine section index).
 */
/** Whitespace- and case-insensitive, because a TOC entry and the book's own
 *  metadata title routinely differ by capitalisation alone. */
function sameTitle(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const left = normalize(a);
  return left.length > 0 && left === normalize(b);
}

export function classifyRidge(
  sections: readonly BookDifficultySection[],
  book: Pick<Book, "format" | "title">,
  bookStatus: BookDifficultyStatus,
): RidgeState {
  const usable = sections.filter((section) => section.totalTokens > 0);
  if (usable.length === 0) {
    // PDFs never get section rows (write_sections skips the format
    // entirely) — that is permanent, not a wait. A non-PDF book whose whole-
    // book row is already `done` but has no section rows yet is the backfill
    // case; anything else (not computed, failed, too short) has nothing to
    // wait for either.
    if (book.format !== "pdf" && bookStatus === "done") return { kind: "backfilling" };
    return { kind: "unavailable" };
  }

  const withShare = usable.map((section) => ({
    ...section,
    hardShare: (section.band4 + section.band5) / section.totalTokens,
  }));
  const sorted = [...withShare].sort((a, b) => a.hardShare - b.hardShare);
  const median = sorted[Math.floor(sorted.length / 2)].hardShare;
  const min = sorted[0].hardShare;
  const max = Math.max(...withShare.map((section) => section.hardShare));
  const range = Math.max(max - min, 0.0001);

  const bars: RidgeBar[] = withShare.map((section) => {
    const norm = (section.hardShare - min) / range;
    return {
      sectionOrder: section.sectionOrder,
      heightPercent: 24 + norm * 76,
      tier: norm >= 0.85 ? "hi" : norm >= 0.55 ? "mid" : "none",
      chapterTitle: section.chapterTitle,
    };
  });

  if (max - median < VERDICT_MARGIN) {
    return { kind: "flat", bars };
  }

  const peak = withShare.reduce((best, section) => (section.hardShare > best.hardShare ? section : best));
  // A section titled after the book itself is not a chapter name. Gutenberg
  // and similar editions open with front matter — title page, contents,
  // licence — whose TOC entry is the book's own title, and that front matter
  // is also, reliably, the densest vocabulary in the file. Naming it produced
  // 「最吃力的一段在「THE ADVENTURES OF TOM SAWYER」前后」: a sentence that
  // tells the reader nothing and points at nothing they will ever read.
  //
  // Dropped rather than downgraded to the flat sentence: "flat" asserts that
  // no chapter stands out, and here one does — we just cannot name it. The
  // mockup's own "对不上目录就整块不出现" rule already covers the untitled
  // peak below for the same reason, so this takes the same exit.
  if (!peak.chapterTitle || sameTitle(peak.chapterTitle, book.title)) {
    // Judgment call: the mockup's "对不上目录就整块不出现" rule is written
    // for this peak-naming case specifically. The flat sentence above never
    // names a chapter, so it can render even when no section in the book has
    // a title — only naming an untitled peak would produce the forbidden
    // machine index ("第 7 段").
    return { kind: "unavailable" };
  }
  return { kind: "peak", bars, peakSectionOrder: peak.sectionOrder, peakTitle: peak.chapterTitle };
}

export function estimateRemainingWords(totalTokens: number, progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return Math.max(0, Math.round(totalTokens * (1 - clamped)));
}

/**
 * Rounded to the nearest whole hour, minimum 1. The mockup itself is
 * inconsistent between a range ("7–8 小时", §1) and a single value ("4 小时",
 * §5) for the same kind of estimate; this standardizes on one rounded point
 * value everywhere rather than carrying that inconsistency into the copy.
 */
export function formatApproxHours(words: number, wordsPerMinute: number | null): number | null {
  if (!wordsPerMinute || wordsPerMinute <= 0 || words <= 0) return null;
  return Math.max(1, Math.round(words / wordsPerMinute / 60));
}

export type ReferenceComparison = "referenceLighter" | "referenceHeavier" | "referenceSimilar";

/** Direction only, never both percentages side by side (mockup §8's "砍"
 *  list explicitly rejects a two-number comparison). */
export function referenceBookComparison(thisShare: number, referenceShare: number): ReferenceComparison {
  const verdict = difficultyVerdict(thisShare, referenceShare);
  if (verdict === "harder") return "referenceLighter";
  if (verdict === "easier") return "referenceHeavier";
  return "referenceSimilar";
}
