import approxSearch, { type Match as StringMatch } from "approx-string-match";

/**
 * Locating a sentence the backend pulled out of the search index inside the
 * page the reader is actually looking at.
 *
 * The two strings are never guaranteed to be identical. `book_chunks.text` is
 * extracted text with whitespace already collapsed; the rendered DOM has
 * footnote markers, ruby annotations, soft hyphens, and typographic
 * punctuation the extractor dropped or spelled differently. A single character
 * of difference is enough to make an exact search — which is what the reader's
 * existing citation jump does — miss the sentence entirely.
 *
 * So the sentence is matched by edit distance instead, and the surrounding
 * text decides between candidates. The approach (search by quote, rank by
 * context, keep a position hint as a tie-breaker) and the weights below follow
 * Hypothesis's annotation anchoring, which solves the same problem for web
 * pages and EPUBs; the code is our own.
 */

/** What the backend recorded about where a sentence sits — see `QuotedSource`. */
export interface QuoteSelector {
  /** The sentence itself. */
  exact: string;
  /** Text immediately before it in the source. May be empty at a chunk edge. */
  prefix?: string;
  /** Text immediately after it. May be empty at a chunk edge. */
  suffix?: string;
  /** Roughly where in `text` the sentence is expected. Tie-breaker only. */
  hint?: number;
}

export interface QuoteMatch {
  start: number;
  end: number;
  /** 0–1. Compare against `MATCH_THRESHOLD`, not against another match. */
  score: number;
}

/**
 * Below this, the best candidate is treated as "not found" and the caller
 * falls back to the section start. Anchoring to the wrong sentence is worse
 * than landing at the top of the right chapter: the reader has no way to tell
 * that a confident-looking highlight is on the wrong line, but they can see
 * for themselves that they are at the top of a chapter.
 */
export const MATCH_THRESHOLD = 0.5;

/**
 * Weights for the four signals. The quote dominates, the two context strings
 * together can override it when two passages read alike, and position only
 * separates candidates that are otherwise tied.
 */
const QUOTE_WEIGHT = 50;
const PREFIX_WEIGHT = 20;
const SUFFIX_WEIGHT = 20;
const POSITION_WEIGHT = 2;

/**
 * Exact matches first — they are what most lookups find, and the approximate
 * search does not special-case them, so it would pay the full dynamic
 * programming cost to rediscover a match `indexOf` already had.
 */
function search(text: string, pattern: string, maxErrors: number): StringMatch[] {
  const exact: StringMatch[] = [];
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
    exact.push({ start: at, end: at + pattern.length, errors: 0 });
  }
  if (exact.length > 0) return exact;
  return approxSearch(text, pattern, maxErrors);
}

/** 1.0 for identical strings, down towards 0 as the edit distance grows. */
function similarity(text: string, pattern: string): number {
  if (!text || !pattern) return 0;
  // Allowing as many errors as the pattern is long guarantees at least one
  // match, so `matches[0]` is always there to read an error count off.
  const matches = search(text, pattern, pattern.length);
  return 1 - matches[0].errors / pattern.length;
}

/**
 * Find where `selector.exact` most likely sits in `text`, or `null` if nothing
 * came close enough to be worth jumping to.
 */
export function matchQuote(text: string, selector: QuoteSelector): QuoteMatch | null {
  const { exact, prefix, suffix, hint } = selector;
  if (!exact || !text) return null;

  // Half the sentence may differ before we stop believing it is the same
  // sentence. The cap keeps the search cost bounded for long quotes — the
  // algorithm is O((maxErrors / 32) * text.length).
  const maxErrors = Math.min(256, Math.floor(exact.length / 2));
  const matches = search(text, exact, maxErrors);
  if (matches.length === 0) return null;

  const scoreOf = (match: StringMatch): number => {
    const quoteScore = 1 - match.errors / exact.length;
    // An absent context string scores 1.0 rather than 0: a sentence at a chunk
    // boundary genuinely has no text on that side, and scoring that as a
    // mismatch would push every such quote under the threshold.
    const prefixScore = prefix
      ? similarity(text.slice(Math.max(0, match.start - prefix.length), match.start), prefix)
      : 1;
    const suffixScore = suffix
      ? similarity(text.slice(match.end, match.end + suffix.length), suffix)
      : 1;
    const positionScore =
      typeof hint === "number" ? 1 - Math.abs(match.start - hint) / text.length : 1;

    const raw =
      QUOTE_WEIGHT * quoteScore
      + PREFIX_WEIGHT * prefixScore
      + SUFFIX_WEIGHT * suffixScore
      + POSITION_WEIGHT * positionScore;
    return raw / (QUOTE_WEIGHT + PREFIX_WEIGHT + SUFFIX_WEIGHT + POSITION_WEIGHT);
  };

  let best: QuoteMatch | null = null;
  for (const match of matches) {
    const score = scoreOf(match);
    if (!best || score > best.score) {
      best = { start: match.start, end: match.end, score };
    }
  }
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}
