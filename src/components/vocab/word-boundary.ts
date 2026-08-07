// Shared Unicode-aware word-boundary matching. Deliberately does not use `\b`,
// which only understands ASCII word characters and misbehaves for non-Latin
// scripts (e.g. it would treat every Han character boundary as a match).
//
// The trailing boundary is a negative lookahead, which every engine we ship to
// understands. The leading one is checked in code instead of with `(?<!…)`:
// WebKit only learned lookbehind in Safari 16.4, and on macOS 12 building such
// a pattern throws `SyntaxError` at the point of construction.
const WORD_CHARACTER = "\\p{L}\\p{N}\\p{M}_";
const STARTS_WITH_WORD_CHARACTER = new RegExp(`^[${WORD_CHARACTER}]`, "u");
const ENDS_WITH_WORD_CHARACTER = new RegExp(`[${WORD_CHARACTER}]$`, "u");
const CONTAINS_HAN = /\p{Script=Han}/u;

export interface WordBoundaryMatch {
  /** Offset into the searched string, as `RegExpExecArray.index` would be. */
  index: number;
  /** The matched slice, which preserves the source's own casing. */
  text: string;
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which boundaries apply to this target: alphabetic targets sit on word
 * boundaries, Han text does not (it is not conventionally segmented by
 * whitespace), and a target that already begins or ends with punctuation
 * carries its own boundary on that side.
 */
function boundaries(target: string) {
  const alphabetic = !CONTAINS_HAN.test(target);
  return {
    leading: alphabetic && STARTS_WITH_WORD_CHARACTER.test(target),
    trailing: alphabetic && ENDS_WITH_WORD_CHARACTER.test(target),
  };
}

/**
 * Every boundary-respecting occurrence of `target` in `source`, in order and
 * non-overlapping — the same set a single lookbehind-and-lookahead pattern
 * would have produced.
 */
export function wordBoundaryMatches(source: string, target: string): WordBoundaryMatch[] {
  if (!source || !target) return [];
  const { leading, trailing } = boundaries(target);
  const pattern = new RegExp(
    `${escapeRegex(target)}${trailing ? `(?![${WORD_CHARACTER}])` : ""}`,
    "giu",
  );

  const matches: WordBoundaryMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const rejected =
      match[0].length === 0
      || (leading && ENDS_WITH_WORD_CHARACTER.test(source.slice(0, match.index)));
    if (rejected) {
      // Resume one character on, which is where a lookbehind would have had
      // the engine retry. Restarting past the whole candidate instead could
      // step over a valid match that begins inside it.
      pattern.lastIndex = match.index + 1;
      continue;
    }
    matches.push({ index: match.index, text: match[0] });
  }
  return matches;
}

/** Returns the first boundary-respecting match, or null. */
export function findWordBoundaryMatch(source: string, target: string): WordBoundaryMatch | null {
  return wordBoundaryMatches(source, target)[0] ?? null;
}
