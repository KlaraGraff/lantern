/**
 * Turns a scrap of book metadata into something a one-line summary can show.
 *
 * `dc:description` in an EPUB is allowed to contain markup, and publishers use
 * that permission freely — the field routinely arrives as
 * `<p>A tale of...</p><p><i>Illustrated</i></p>`. Nothing downstream renders it
 * as HTML (it lands in a `truncate`d line in the shelf's list view), so the
 * tags showed up as literal text and ate the first line of every blurb.
 *
 * Rendering it as HTML instead is not the fix: the string comes from a file the
 * reader downloaded, so it is untrusted, and the row it sits in has room for
 * one line of prose and no styling budget at all.
 *
 * Deliberately string-only rather than `DOMParser` or an off-document
 * `innerHTML`: this runs once per card per render on the shelf's hot path, both
 * of those touch the DOM, and neither buys anything for input this shallow.
 * Malformed markup degrades to "a bit of stray text", which is what a truncated
 * blurb can afford.
 */

/** The five XML predefined entities, plus the two that show up in real blurbs. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
};

/** `String.fromCodePoint` without the throw on a number outside Unicode. */
function codePoint(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return null;
  return String.fromCodePoint(value);
}

export function toPlainText(input: string): string {
  return input
    // A block boundary is a word boundary: without this, `</p><p>` welds the
    // last word of one paragraph to the first of the next.
    .replace(/<\/?(?:p|br|div|li|h[1-6]|tr)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    // One pass over every entity form, so a literal `&amp;lt;` decodes to
    // `&lt;` and stops there rather than unwinding into a `<` nobody wrote.
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) return codePoint(Number(dec)) ?? match;
      if (hex !== undefined) return codePoint(parseInt(hex, 16)) ?? match;
      return ENTITIES[name!.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
