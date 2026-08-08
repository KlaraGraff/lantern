import type { FoliateView } from "./foliate-types.ts";
import { loadFoliateModules, type MakeRange } from "./foliate-modules.ts";
import { matchQuote, type QuoteSelector } from "./matchQuote.ts";

/**
 * Turning a sentence the backend recorded into a live Range in the section the
 * reader has open.
 *
 * Foliate's own search walks the same text nodes but requires the query to
 * match character for character once whitespace, case, and diacritics are
 * normalized. That is enough for a citation lifted out of the page mid-session
 * and not enough for a sentence that came back out of the index: see
 * `matchQuote` for what differs between the two strings. This module keeps the
 * walking and offset-mapping — which is where the fiddly part is — and swaps
 * the exact search for an approximate one.
 */

interface NodeRange {
  startIndex: number;
  startOffset: number;
  endIndex: number;
  endOffset: number;
  score: number;
}

/**
 * The concatenated text nodes, with every run of whitespace collapsed to one
 * space, plus a map from each character back to where it came from.
 *
 * The collapsing is not cosmetic. EPUB XHTML is usually wrapped and indented,
 * so a text node holds "…of the bank.\n      The teller…" where the extracted
 * chunk holds "…of the bank. The teller…". Left raw, every line break in a
 * quoted sentence would count as several character errors — enough to bury a
 * genuine match under a spurious one. `book_chunks.text` was collapsed the same
 * way at index time, so this puts both strings in the same shape.
 */
interface FlatText {
  /** Whitespace-collapsed text of the whole section. */
  text: string;
  /** `raw[i]` is the offset in `strs.join("")` that `text[i]` came from. */
  raw: number[];
  /** Total length of `strs.join("")`. */
  rawLength: number;
}

function flatten(strs: string[]): FlatText {
  let text = "";
  const raw: number[] = [];
  let cursor = 0;
  for (const str of strs) {
    for (const char of str) {
      if (/\s/.test(char)) {
        // Collapse: only the first character of a whitespace run is kept, and
        // it stands in for the whole run.
        if (!text.endsWith(" ")) {
          text += " ";
          raw.push(cursor);
        }
      } else {
        text += char;
        raw.push(cursor);
      }
      cursor += char.length;
    }
  }
  return { text, raw, rawLength: cursor };
}

/** Map an offset in `strs.join("")` to the node holding it and the offset within. */
function locateOffset(strs: string[], offset: number): { index: number; offset: number } {
  let consumed = 0;
  for (let index = 0; index < strs.length; index += 1) {
    const next = consumed + strs[index].length;
    // `<=` on the last node so an offset at the very end of the section lands
    // on that node's end rather than falling off the array.
    if (offset < next || index === strs.length - 1) {
      return { index, offset: Math.min(offset - consumed, strs[index].length) };
    }
    consumed = next;
  }
  return { index: 0, offset: 0 };
}

/**
 * Find `selector` in a walked run of text nodes. Exported for its own sake:
 * this is the whole algorithm minus the DOM, so it can be tested on plain
 * arrays of strings.
 */
export function locateQuote(strs: string[], selector: QuoteSelector): NodeRange | null {
  if (strs.length === 0) return null;
  const flat = flatten(strs);
  const collapse = (str: string | undefined) => (str ?? "").replace(/\s+/g, " ").trim();

  const found = matchQuote(flat.text, {
    exact: collapse(selector.exact),
    prefix: collapse(selector.prefix),
    suffix: collapse(selector.suffix),
    hint: selector.hint,
  });
  if (!found) return null;

  const rawStart = flat.raw[found.start] ?? flat.rawLength;
  // One past the last matched character, so the range covers it. `found.end`
  // is exclusive, and a match that runs to the end of the section has no
  // following character to read a start from.
  const rawEnd = found.end > 0 ? (flat.raw[found.end - 1] ?? flat.rawLength) + 1 : rawStart;

  const start = locateOffset(strs, rawStart);
  const end = locateOffset(strs, rawEnd);
  return {
    startIndex: start.index,
    startOffset: start.offset,
    endIndex: end.index,
    endOffset: end.offset,
    score: found.score,
  };
}

/**
 * Locate `selector` in `doc` and return a Range over it, or `null` if nothing
 * on the page resembles the sentence closely enough to jump to.
 */
export async function anchorQuote(
  doc: Document,
  selector: QuoteSelector,
): Promise<Range | null> {
  const { textWalker } = await loadFoliateModules();
  const walk = textWalker(doc, function* (strs: string[], makeRange: MakeRange) {
    const located = locateQuote(strs, selector);
    if (located) {
      yield makeRange(
        located.startIndex,
        located.startOffset,
        located.endIndex,
        located.endOffset,
      );
    }
  });
  for (const range of walk) return range;
  return null;
}

/**
 * A CFI pointing at `selector` inside section `sectionIndex`, or `null` when
 * the sentence cannot be found there.
 *
 * The section's document is built fresh rather than read out of the rendered
 * iframe: the reader is normally somewhere else in the book when a quote is
 * clicked, so that section is not on screen to be read from — and this is the
 * same route foliate's own search takes (`#searchSection` in `view.js`).
 * A CFI, once produced, is a location the reader can navigate to like any
 * other, so the detached document is thrown away immediately.
 */
export async function anchorQuoteCfi(
  view: FoliateView,
  sectionIndex: number,
  selector: QuoteSelector,
): Promise<string | null> {
  const section = view.book?.sections?.[sectionIndex];
  if (!section?.createDocument) return null;
  try {
    const doc: Document = await section.createDocument();
    const range = await anchorQuote(doc, selector);
    return range ? view.getCFI(sectionIndex, range) : null;
  } catch {
    // A section that will not build a document is a book problem, not a
    // reason to fail the jump — the caller still has the section start.
    return null;
  }
}
