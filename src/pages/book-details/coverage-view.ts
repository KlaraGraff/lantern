import type { BookReaderCoverage, UnknownWord, VocabProfileSummary } from "../../hooks/useBookCoverage.ts";
// Explicit extension: this module is exercised by node:test through
// `--experimental-strip-types`, which does no extensionless resolution.
import { MIN_BASELINE_BOOKS } from "./difficulty-view.ts";
import { UNLISTED_BAND_COLOR } from "../../components/word-frequency-bands.ts";

/**
 * Everything the "这本书对你" card derives from a coverage row, with no React
 * and no Tauri in sight.
 *
 * The card makes a claim about a person's reading — "you can read this one" —
 * off four token counts, and the rule that turns those counts into either a
 * point or a range is the whole of the honesty of the thing. It belongs
 * somewhere it can be asserted, not somewhere it can only be looked at.
 */

/**
 * Nation's two reading thresholds: at 95% of the running words known a reader
 * gets through the text with a dictionary; at 98% they get through it without
 * one. They are a ruler, not a score.
 */
export const THRESHOLD_ASSISTED = 0.95;
export const THRESHOLD_INDEPENDENT = 0.98;

/**
 * The scale starts at 88%, not at 0%. Both thresholds live in the last five
 * percent of the range, and on a 0–100 axis they would sit in the same hair's
 * breadth at the right edge — which would make a ruler that cannot be read.
 */
export const SCALE_MIN = 0.88;
export const SCALE_MAX = 1;

/** Where a share sits on that scale, 0–1, clamped to its ends. */
export function scalePosition(share: number): number {
  const position = (share - SCALE_MIN) / (SCALE_MAX - SCALE_MIN);
  return Math.min(1, Math.max(0, position));
}

/**
 * How wide the two bounds may be before a single number is worth printing.
 * One percentage point of running text is about one word in a hundred — below
 * that, the two ends of the range would round to captions that say the same
 * thing.
 */
export const INTERVAL_WIDTH_LIMIT = 0.01;

export interface CoverageBounds {
  /** Only what the reader has demonstrably mastered, plus proper nouns. */
  lower: number;
  /** Mastered, plus "眼熟", plus proper nouns. */
  upper: number;
}

/**
 * The two ends of the honest answer.
 *
 * These are not a confidence interval and no statistics were harmed making
 * them: they are the two readings the same data supports, depending on whether
 * a word the reader has seen a few times and never looked up counts as known.
 * Nobody knows, including the reader. Reading more turns "眼熟" words into
 * mastered ones, which narrows the gap on its own.
 */
export function coverageBounds(row: Pick<BookReaderCoverage,
  "totalTokens" | "masteredTokens" | "familiarTokens" | "nameTokens">): CoverageBounds {
  if (row.totalTokens <= 0) return { lower: 0, upper: 0 };
  const settled = row.masteredTokens + row.nameTokens;
  return {
    lower: settled / row.totalTokens,
    upper: (settled + row.familiarTokens) / row.totalTokens,
  };
}

/**
 * Which of the three cells of the ladder is filled. Position, never colour:
 * the same accent paints all three, and what changes is which one is lit and
 * the sentence beside it.
 */
export type CoverageBand = "dense" | "assisted" | "independent";

export function coverageBand(share: number): CoverageBand {
  if (share >= THRESHOLD_INDEPENDENT) return "independent";
  if (share >= THRESHOLD_ASSISTED) return "assisted";
  return "dense";
}

export type CoverageReading =
  | { kind: "point"; share: number; band: CoverageBand }
  | {
      kind: "interval";
      low: number;
      high: number;
      /** The thresholds the range straddles, low to high. Non-empty means the
       *  range cannot answer the question the card exists to answer, and the
       *  card says so instead of picking a side. */
      spans: number[];
      /** The verdict both ends agree on, or `null` when `spans` is non-empty. */
      band: CoverageBand | null;
    };

/**
 * A point or a range, and never a point the data cannot carry.
 *
 * Two gates, both of which must pass. Books read must reach the same floor the
 * difficulty verdict uses — a reader two chapters in may have a narrow range
 * purely by accident of having met almost no words twice — and the range must
 * be narrow enough that its two ends would round to the same story. The width
 * gate is not guessing whether the sample is large; it measures the
 * uncertainty directly, which is why no invented threshold is needed here.
 */
export function coverageReading(
  row: Pick<BookReaderCoverage,
    "totalTokens" | "masteredTokens" | "familiarTokens" | "nameTokens" | "baselineBooks">,
  countFamiliar: boolean,
): CoverageReading {
  const { lower, upper } = coverageBounds(row);
  const wideEnoughSample = row.baselineBooks >= MIN_BASELINE_BOOKS;
  // The width is the "眼熟" band's share of the book, compared in tokens
  // rather than as a difference of two shares: subtracting one ratio from
  // another puts the answer a hair either side of the limit on the very
  // counts that sit exactly on it.
  const narrowEnough = row.familiarTokens <= row.totalTokens * INTERVAL_WIDTH_LIMIT;
  if (wideEnoughSample && narrowEnough) {
    const share = countFamiliar ? upper : lower;
    return { kind: "point", share, band: coverageBand(share) };
  }
  const spans = [THRESHOLD_ASSISTED, THRESHOLD_INDEPENDENT].filter(
    (line) => lower < line && upper >= line,
  );
  return {
    kind: "interval",
    low: lower,
    high: upper,
    spans,
    band: spans.length === 0 ? coverageBand(lower) : null,
  };
}

export interface CoverageSlice {
  key: "mastered" | "familiar" | "name" | "unknown";
  tokens: number;
  /** 0–1 of the whole book. */
  share: number;
  color: string;
}

/**
 * The four rows of "这本书的词次构成", always in this order and always summing
 * to the book. They are drawn the same way whichever side of the line "眼熟"
 * is counted on — the setting moves the coverage number, not the anatomy.
 */
export function compositionSlices(row: Pick<BookReaderCoverage,
  "totalTokens" | "masteredTokens" | "familiarTokens" | "nameTokens" | "unknownTokens">): CoverageSlice[] {
  const total = row.totalTokens > 0 ? row.totalTokens : 0;
  const share = (tokens: number) => (total > 0 ? tokens / total : 0);
  return [
    {
      key: "mastered",
      tokens: row.masteredTokens,
      share: share(row.masteredTokens),
      color: "var(--color-band-1)",
    },
    {
      key: "familiar",
      tokens: row.familiarTokens,
      share: share(row.familiarTokens),
      color: "var(--color-band-2)",
    },
    {
      key: "name",
      tokens: row.nameTokens,
      share: share(row.nameTokens),
      color: UNLISTED_BAND_COLOR,
    },
    {
      key: "unknown",
      tokens: row.unknownTokens,
      share: share(row.unknownTokens),
      color: "var(--color-band-4)",
    },
  ];
}

/**
 * A reader who has never read anything here. Distinct from a thin sample: the
 * empty state draws the ruler with nothing on it and invents no percentage,
 * where the thin-sample state has a range to show.
 */
export function isProfileEmpty(summary: VocabProfileSummary | null): boolean {
  if (!summary) return true;
  return (
    summary.booksRead === 0 &&
    summary.exposureTokens === 0 &&
    summary.lookupRecords === 0 &&
    summary.vocabWords === 0
  );
}

/**
 * The profile has moved on since this row was computed. Only ever a caption
 * ("这是 7 月 21 日那份词汇画像算出来的"); nothing recomputes on its own.
 */
export function profileMovedOn(
  row: Pick<BookReaderCoverage, "profileAt"> | null,
  summary: VocabProfileSummary | null,
): boolean {
  if (!row?.profileAt || !summary?.updatedAt) return false;
  return summary.updatedAt > Date.parse(row.profileAt);
}

/**
 * Whether a word the reader has met a few times and never looked up counts as
 * known (D2). Default on: it is the reading the two thresholds were written
 * about, and the footnote always prints the other one beside it, so the choice
 * is visible rather than hidden in a setting.
 */
export const COUNT_FAMILIAR_SETTING_KEY = "coverage_count_familiar";

/**
 * Whether the shelf shows each book's coverage under its title (D7). Default
 * off — a shelf of numbers invites comparing books to each other, which is the
 * one thing this measurement is not for.
 */
export const SHELF_COVERAGE_SETTING_KEY = "coverage_show_on_shelf";

export function countFamiliarFrom(settings: Record<string, string>): boolean {
  return settings[COUNT_FAMILIAR_SETTING_KEY] !== "false";
}

export function shelfCoverageFrom(settings: Record<string, string>): boolean {
  return settings[SHELF_COVERAGE_SETTING_KEY] === "true";
}

export type WordGroupKey = "frequent" | "recurring" | "rare";

/**
 * Where the unknown words are cut into three. By occurrences in *this book*,
 * because that is what decides how the book reads: a word met ninety times is
 * a wall, and the same word met once is a footnote.
 */
export const FREQUENT_FROM = 40;
export const RECURRING_FROM = 5;

/** How many of the once-or-twice words are shown before "…还有 N 个". */
export const RARE_PREVIEW_LIMIT = 6;

export interface WordGroup {
  key: WordGroupKey;
  words: UnknownWord[];
  /** Distinct forms in this group. */
  forms: number;
  /** Their occurrences, summed. */
  tokens: number;
}

export function groupUnknownWords(words: readonly UnknownWord[]): WordGroup[] {
  const keyOf = (word: UnknownWord): WordGroupKey => {
    if (word.tokens >= FREQUENT_FROM) return "frequent";
    if (word.tokens >= RECURRING_FROM) return "recurring";
    return "rare";
  };
  const groups: WordGroup[] = (["frequent", "recurring", "rare"] as const).map((key) => ({
    key,
    words: [],
    forms: 0,
    tokens: 0,
  }));
  for (const word of words) {
    const group = groups.find((candidate) => candidate.key === keyOf(word));
    if (!group) continue;
    group.words.push(word);
    group.forms += 1;
    group.tokens += word.tokens;
  }
  return groups.filter((group) => group.forms > 0);
}

/**
 * What coverage would read if the reader learned one group. Stated as an
 * observation about the text, not as a target — the group with eleven words in
 * it moves the number because those eleven words are everywhere, and that is
 * worth knowing before deciding where to spend an evening.
 */
export function shareAfterLearning(share: number, groupTokens: number, totalTokens: number): number {
  if (totalTokens <= 0) return share;
  return Math.min(1, share + groupTokens / totalTokens);
}

export type WordChip =
  | { kind: "familiar" }
  | { kind: "lookups"; count: number }
  | { kind: "seen"; count: number }
  | { kind: "never" };

/**
 * The one piece of evidence worth putting beside a word.
 *
 * Ordered by how much it explains. "眼熟" first: it says this word is only in
 * the list because the reader turned the setting off, which no encounter count
 * would convey. Then a lookup, which is direct evidence of not knowing it;
 * then encounters without a lookup; then nothing at all, which is its own
 * answer — the reader has simply never met this word.
 */
export function wordChip(word: Pick<UnknownWord, "familiar" | "lookups" | "encounters">): WordChip {
  if (word.familiar) return { kind: "familiar" };
  if (word.lookups > 0) return { kind: "lookups", count: word.lookups };
  if (word.encounters > 0) return { kind: "seen", count: word.encounters };
  return { kind: "never" };
}

/**
 * The shelf badge (08, D7), or `null` for a book that does not get one.
 *
 * A badge is one number in the corner of a cover; it has no room to say "some
 * number between 93 and 97, and here is why". So it uses the same gate the
 * card uses and stays away when the honest answer is a range — the book's own
 * page is where a range gets the sentence it needs.
 */
export function shelfCoverageLabel(
  row: Parameters<typeof coverageReading>[0],
  countFamiliar: boolean,
): string | null {
  const reading = coverageReading(row, countFamiliar);
  return reading.kind === "point" ? formatCoverage(reading.share) : null;
}

/** `0.9641` → `"96.4"`. One decimal everywhere, so ruler and prose agree. */
export function formatCoverage(share: number): string {
  return (share * 100).toFixed(1);
}

/**
 * The CSV behind "导出这张表" (D5). Written here rather than in the component
 * so the quoting rule is testable: a gloss is free text a reader typed, and
 * one comma in it would otherwise shift every column after it.
 */
export function unknownWordsCsv(words: readonly UnknownWord[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = ["word,tokens,gloss,encounters,lookups"];
  for (const word of words) {
    lines.push([
      escape(word.word),
      String(word.tokens),
      escape(word.gloss ?? ""),
      String(word.encounters),
      String(word.lookups),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}
