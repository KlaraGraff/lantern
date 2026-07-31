import type { DictionaryWord } from "../../hooks/useDictionary";

/**
 * Keeps a long book title recognizable by dropping the middle rather than the
 * end — the tail of a title is often what distinguishes it from its siblings.
 */
export function truncateMiddle(value: string, max = 30): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head).trimEnd()}…${value.slice(value.length - tail).trimStart()}`;
}

/**
 * Pulls the leading `/.../` phonetic and an optional `noun.`/`verb.` off the
 * first paragraph, so a row shows a gloss rather than IPA that the play button
 * already covers.
 */
export function parseDefinition(raw: string): { pronunciation: string | null; definition: string } {
  const breakIndex = raw.search(/\n\n+/);
  const head = breakIndex === -1 ? raw : raw.slice(0, breakIndex);
  const tail = breakIndex === -1 ? "" : raw.slice(breakIndex).replace(/^\n+/, "");
  const match = head.match(/^\s*(\/[^/]+\/)\s*(?:(\w+)\.)?\s*([\s\S]*)$/);
  const headRemainder = (match ? match[3] ?? "" : head).trim();
  const definition = headRemainder && tail
    ? `${headRemainder}\n\n${tail}`
    : headRemainder || tail;
  return { pronunciation: match?.[1] ?? null, definition };
}

/** The single-line gloss for a collapsed row: first line, no markdown noise. */
export function glossOf(definition: string): string {
  return definition
    .split("\n")
    .map((line) => line.replace(/^[#>\-*\s]+/, "").trim())
    .find((line) => line.length > 0)
    ?? "";
}

/** Everything the copy action puts on the clipboard, expanded or not. */
export function entryClipboardText(word: DictionaryWord, source: string): string {
  const { definition } = parseDefinition(word.definition);
  return [
    word.word,
    definition,
    word.context_sentence?.trim() ? `"${word.context_sentence.trim()}"` : "",
    word.context_explanation?.trim(),
    source,
  ].filter(Boolean).join("\n\n");
}
