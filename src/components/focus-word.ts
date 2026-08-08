/**
 * The word a follow-up is *about*, when there is one.
 *
 * A follow-up launched from a lookup, a translation, or an explanation carries
 * the whole card into the composer — the text, its sentence, and the model's
 * answer. That is what the reader wants quoted back at them, but it is not a
 * search query. The backend's example-sentence retrieval
 * (`ai::grounding::quotes::find_quotes`) takes one word and looks for real
 * sentences using it elsewhere in the library, so it needs the word on its own.
 *
 * Absent is the normal answer. Selecting a clause and asking about it is a
 * question about that clause, not about a term, and handing a clause to a
 * word-form lookup returns nothing while costing a library-wide index scan.
 * So this only says yes to something word-shaped.
 */

/** Any punctuation that only ever falls *between* clauses. Its presence is the
 *  clearest evidence a selection is a stretch of prose rather than a term —
 *  and in CJK it is often the only whitespace-like evidence available. */
const CLAUSE_PUNCTUATION = /[，。；！？、：…—,;!?]/;
/** A hyphenated compound or a long technical term still reads as one word. */
const MAX_LATIN_CHARS = 24;
/** CJK writes without spaces, so length is nearly all there is to go on: a
 *  four-character idiom is a word, ten characters is a sentence. */
const MAX_CJK_CHARS = 8;
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

export function focusWordFor(text: string): string | undefined {
  const word = text.trim();
  // No internal whitespace — the same rule the explain card already uses to
  // tell a word selection from a passage.
  if (!word || /\s/.test(word)) return undefined;
  if (CLAUSE_PUNCTUATION.test(word)) return undefined;
  const characters = [...word];
  const limit = characters.some((character) => CJK.test(character))
    ? MAX_CJK_CHARS
    : MAX_LATIN_CHARS;
  return characters.length <= limit ? word : undefined;
}
