// Shared Unicode-aware word-boundary matching. Deliberately does not use `\b`,
// which only understands ASCII word characters and misbehaves for non-Latin
// scripts (e.g. it would treat every Han character boundary as a match).
const WORD_CHARACTER = "\\p{L}\\p{N}\\p{M}_";

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a regex that matches `target` inside a larger string only when it
 * sits on a word boundary (for alphabetic targets) or as a plain substring
 * (for Han text, which is not conventionally segmented by whitespace).
 */
export function wordBoundaryRegex(target: string, flags = "iu") {
  const escaped = escapeRegex(target);
  const useAlphabeticBoundaries = !/\p{Script=Han}/u.test(target);
  const firstIsWord = new RegExp(`^[${WORD_CHARACTER}]`, "u").test(target);
  const lastIsWord = new RegExp(`[${WORD_CHARACTER}]$`, "u").test(target);
  return new RegExp(
    `${useAlphabeticBoundaries && firstIsWord ? `(?<![${WORD_CHARACTER}])` : ""}${escaped}${useAlphabeticBoundaries && lastIsWord ? `(?![${WORD_CHARACTER}])` : ""}`,
    flags,
  );
}

/** Returns the first boundary-respecting match, or null. */
export function findWordBoundaryMatch(source: string, target: string) {
  const match = wordBoundaryRegex(target, "iu").exec(source);
  return match && match.index !== undefined ? match : null;
}
