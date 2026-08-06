import type { BookDifficulty } from "../../hooks/useBookDifficulty";
// Explicit extension: this module is exercised by node:test through
// `--experimental-strip-types`, which does no extensionless resolution.
import { FREQUENCY_BANDS, UNLISTED_BAND_COLOR } from "../../components/word-frequency-bands.ts";

/**
 * Everything the difficulty card derives from a row, with no React and no
 * Tauri in sight. The verdict is a claim about a reader's library, so it is
 * worth being able to assert its thresholds in a test rather than by staring
 * at a rendered bar.
 */

export interface BandSlice {
  /** 1–5, or `null` for the sixth bucket: not in the table at all. */
  band: 1 | 2 | 3 | 4 | 5 | null;
  tokens: number;
  /** 0–1. */
  share: number;
  color: string;
  from: number | null;
  to: number | null;
}

/**
 * Six slices, always in this order, always summing to the whole. The unlisted
 * bucket is last and separate; folding it into band 5 would make every novel
 * with a made-up place name look rarer than it is.
 */
export function bandSlices(row: Pick<BookDifficulty,
  "band1" | "band2" | "band3" | "band4" | "band5" | "bandUnlisted" | "totalTokens">): BandSlice[] {
  const total = row.totalTokens > 0 ? row.totalTokens : 0;
  const slices: BandSlice[] = FREQUENCY_BANDS.map((band) => {
    const tokens = row[band.field];
    return {
      band: band.band,
      tokens,
      share: total > 0 ? tokens / total : 0,
      color: band.color,
      from: band.from,
      to: band.to,
    };
  });
  slices.push({
    band: null,
    tokens: row.bandUnlisted,
    share: total > 0 ? row.bandUnlisted / total : 0,
    color: UNLISTED_BAND_COLOR,
    from: null,
    to: null,
  });
  return slices;
}

/**
 * The share of running text that sits in bands 4 and 5 — the two bands where a
 * reader stops coasting. This single number is what the verdict compares; the
 * unlisted bucket is deliberately not part of it, since a recurring character
 * name costs a reader nothing after its first appearance.
 */
export function hardShare(row: Pick<BookDifficulty,
  "band4" | "band5" | "totalTokens">): number {
  if (row.totalTokens <= 0) return 0;
  return (row.band4 + row.band5) / row.totalTokens;
}

/** The share in bands 1 and 2 — the part of a book that reads without effort. */
export function easyShare(row: Pick<BookDifficulty,
  "band1" | "band2" | "totalTokens">): number {
  if (row.totalTokens <= 0) return 0;
  return (row.band1 + row.band2) / row.totalTokens;
}

/**
 * Two books is the floor for calling anything "what you usually read". With
 * one book behind you, the comparison is to that book, not to a habit, and
 * saying otherwise would be a stronger claim than the data supports.
 */
export const MIN_BASELINE_BOOKS = 2;

/**
 * How far apart two hard-word shares have to be before the difference is worth
 * a sentence. Two points of running text is roughly one extra unfamiliar word
 * per fifty — below that, the honest answer is "about the same".
 */
export const VERDICT_MARGIN = 0.02;

export type DifficultyVerdict = "easier" | "similar" | "harder" | "unclear";

/**
 * Mean hard-word share across the books the reader has actually finished.
 * `null` when too few of them have been analyzed to speak of a baseline.
 */
export function baselineHardShare(rows: readonly Pick<BookDifficulty,
  "band4" | "band5" | "totalTokens" | "status">[]): number | null {
  const usable = rows.filter((row) => row.status === "done" && row.totalTokens > 0);
  if (usable.length < MIN_BASELINE_BOOKS) return null;
  const sum = usable.reduce((acc, row) => acc + hardShare(row), 0);
  return sum / usable.length;
}

/**
 * Where this book sits against that baseline. `unclear` is a conclusion, not a
 * failure state — it is what the page says when there is nothing to compare
 * against, and it renders at the same weight as the other three.
 */
export function difficultyVerdict(share: number, baseline: number | null): DifficultyVerdict {
  if (baseline === null) return "unclear";
  const delta = share - baseline;
  if (delta >= VERDICT_MARGIN) return "harder";
  if (delta <= -VERDICT_MARGIN) return "easier";
  return "similar";
}

/**
 * A verdict the reader wrote themselves replaces the sentence, never the
 * numbers. `hidden` means they want no sentence at all.
 */
export function effectiveVerdict(
  auto: DifficultyVerdict,
  override: BookDifficulty["override"],
): DifficultyVerdict | "hidden" {
  if (override === null) return auto;
  if (override === "hidden") return "hidden";
  if (override === "matched") return "similar";
  return override;
}

/** `0.0841` → `"8.4"`. One decimal everywhere, so the bar and the table agree. */
export function formatShare(share: number): string {
  return (share * 100).toFixed(1);
}
