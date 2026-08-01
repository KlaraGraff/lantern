import type { SpeechKind, SpeechSettings, SpeechSourceId } from "./types";

/** A source that can actually produce audio, so never `"auto"`. */
export type SpeechRoute = Exclude<SpeechSourceId, "auto">;

/**
 * Word timings the Edge service returns alongside the audio. Only the fields
 * that survive the trip matter here — the service also reports a boundary type,
 * but every entry it sends is a word boundary.
 */
export interface WordTiming {
  text: string;
  offsetMs: number;
  durationMs: number;
}

/** A sentence and where it sits in the text it was cut from. */
export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/** A sentence with the moment the audio reaches it. */
export interface TimedSentence extends SentenceSpan {
  startMs: number;
}

const Segmenter = (Intl as typeof Intl & {
  Segmenter?: new (
    locale?: string,
    options?: { granularity: "sentence" },
  ) => { segment(value: string): Iterable<{ segment: string; index: number }> };
}).Segmenter;

/**
 * Titles the platform segmenter breaks after even though they do not end a
 * sentence. Measured, not assumed: `Intl.Segmenter` already keeps `3.5` and
 * `e.g.` intact, but splits `Mr. Darcy` into `Mr.` and `Darcy said…`. This is the
 * short list of what it still gets wrong, not a general abbreviation dictionary.
 *
 * Getting this wrong is audible as well as visible — a chunk boundary landing
 * after `Mr.` breaks the audio in the middle of a name.
 *
 * Words that plausibly end a sentence are deliberately absent: `no.` meaning
 * "number" would be indistinguishable from someone saying no.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "st", "jr", "sr", "messrs", "mt",
  "rev", "hon", "capt", "sgt", "lt", "col", "gen", "fig", "vol",
]);

function endsWithAbbreviation(text: string): boolean {
  const match = text.trimEnd().match(/(\p{L}+)\.$/u);
  return match !== null && NON_TERMINAL_ABBREVIATIONS.has(match[1].toLowerCase());
}

/** Joins a span onto the one after it, keeping the outer offsets. */
function mergeAbbreviationBreaks(spans: SentenceSpan[], text: string): SentenceSpan[] {
  const merged: SentenceSpan[] = [];
  for (const span of spans) {
    // Indexed rather than `at(-1)`: the reader targets the Safari 15 WKWebView,
    // which has no `Array.prototype.at`, and the build audit fails on it.
    const previous = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (previous && endsWithAbbreviation(previous.text)) {
      previous.end = span.end;
      previous.text = text.slice(previous.start, previous.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * Routing for one playback, most-preferred source first. Every plan ends at the
 * system voices, which are the only source that cannot fail for a reason worth
 * escalating.
 *
 * `auto` never routes to the custom provider: it is billed per use, and a source
 * chosen on the user's behalf must not be one that spends their money. Picking
 * it explicitly still works, and always has.
 */
export function planSources(kind: SpeechKind, settings: SpeechSettings): SpeechRoute[] {
  switch (settings.source) {
    case "auto":
      // A short selection asks the dictionary first because its recordings are
      // human, and it answers "no entry" quickly enough to be worth asking. A
      // passage never has an entry, so asking would only cost a round trip.
      return kind === "passage"
        ? ["edge", "system"]
        : ["dictionary", "edge", "system"];
    case "dictionary":
      return kind === "passage" ? ["system"] : ["dictionary", "system"];
    case "edge":
      return ["edge", "system"];
    case "custom":
      return ["custom", "system"];
    case "system":
      return ["system"];
  }
}

/**
 * Splits text into sentences, keeping each one's offsets so a span can later be
 * turned back into a DOM range.
 *
 * `Intl.Segmenter` is feature-detected because the reader targets the Safari 15
 * WKWebView on macOS 12. The fallback splits on sentence punctuation followed by
 * a space, which is wrong for `Mr. Darcy` — that is why it is a fallback and not
 * the implementation.
 */
export function segmentSentences(text: string, locale?: string): SentenceSpan[] {
  if (!text.trim()) return [];
  const spans: SentenceSpan[] = [];

  if (Segmenter) {
    for (const { segment, index } of new Segmenter(locale, { granularity: "sentence" }).segment(text)) {
      if (segment.trim()) spans.push({ text: segment, start: index, end: index + segment.length });
    }
    return mergeAbbreviationBreaks(spans, text);
  }

  const pattern = /[^.!?。！？]*[.!?。！？]+[\s"'”’)\]]*|[^.!?。！？]+$/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].trim()) spans.push({ text: match[0], start, end: start + match[0].length });
  }
  if (spans.length === 0) return [{ text, start: 0, end: text.length }];
  return mergeAbbreviationBreaks(spans, text);
}

/** One synthesis request, and which of the source sentences it covers. */
export interface SynthesisChunk {
  text: string;
  /** Index of the first source sentence in this chunk. */
  firstSentence: number;
  /** How many source sentences it covers. Zero only for an over-long split. */
  sentenceCount: number;
}

/**
 * Groups already-segmented sentences into requests no larger than the backend
 * accepts, recording which sentences each request covers.
 *
 * Chunks are as large as the cap allows rather than one sentence each: the Edge
 * service is unofficial and free, and hundreds of small requests for one chapter
 * is the surest way to be rate-limited. Synthesizing a paragraph whole also
 * keeps its intonation across sentence boundaries.
 *
 * Taking sentences rather than raw text is what lets the reader line playback up
 * with the page. The caller cuts the sentences out of the DOM once, and both the
 * audio and the highlight refer to that same list by index — no second
 * segmentation that could disagree with the first.
 *
 * A single sentence longer than the cap is split on whitespace, since the
 * alternative is refusing to read it at all.
 */
export function chunkSentences(sentences: string[], limit: number): SynthesisChunk[] {
  const chunks: SynthesisChunk[] = [];
  let current = "";
  let firstSentence = 0;
  let sentenceCount = 0;

  const push = () => {
    if (current.trim()) chunks.push({ text: current.trim(), firstSentence, sentenceCount });
    current = "";
    sentenceCount = 0;
  };

  for (const [index, raw] of sentences.entries()) {
    const piece = raw.split(/\s+/u).join(" ").trim();
    if (!piece) continue;

    if (piece.length > limit) {
      push();
      const parts = splitOnWhitespace(piece, limit);
      for (const [part, text] of parts.entries()) {
        // The whole run of parts belongs to this one sentence, so only the first
        // claims it; the rest report none and leave the highlight where it is.
        chunks.push({ text, firstSentence: index, sentenceCount: part === 0 ? 1 : 0 });
      }
      firstSentence = index + 1;
      continue;
    }

    if (current && current.length + 1 + piece.length > limit) {
      push();
      firstSentence = index;
    }
    if (!current) firstSentence = index;
    current = current ? `${current} ${piece}` : piece;
    sentenceCount += 1;
  }
  push();
  return chunks;
}

/** Chunk plain text, for callers with no sentence list of their own. */
export function chunkForSynthesis(text: string, limit: number, locale?: string): string[] {
  const normalized = text.split(/\s+/u).join(" ").trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];
  return chunkSentences(
    segmentSentences(normalized, locale).map((sentence) => sentence.text),
    limit,
  ).map((chunk) => chunk.text);
}

function splitOnWhitespace(text: string, limit: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && current.length + 1 + word.length > limit) {
      parts.push(current);
      current = "";
    }
    // A single word past the cap has no split point that keeps it a word, so it
    // is cut rather than dropped.
    if (word.length > limit) {
      if (current) parts.push(current);
      current = "";
      for (let index = 0; index < word.length; index += limit) {
        parts.push(word.slice(index, index + limit));
      }
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Assigns each sentence the moment the audio reaches it.
 *
 * The service reports each word's text and audio offset but not where the word
 * sits in the text, so positions are recovered by advancing a cursor: words
 * arrive in spoken order, so the next occurrence at or after the cursor is the
 * right one. Searching the whole string instead would match an earlier repeat of
 * a common word and walk the timeline backwards.
 *
 * A sentence no word could be matched to inherits the previous sentence's start,
 * which keeps the timeline non-decreasing so the lookup stays correct.
 */
export function timeSentences(
  text: string,
  timings: WordTiming[],
  locale?: string,
): TimedSentence[] {
  const sentences = segmentSentences(text, locale);
  if (sentences.length === 0) return [];

  const positions: { index: number; offsetMs: number }[] = [];
  let cursor = 0;
  for (const timing of timings) {
    const word = timing.text.trim();
    if (!word) continue;
    const found = text.indexOf(word, cursor);
    if (found < 0) continue;
    positions.push({ index: found, offsetMs: timing.offsetMs });
    cursor = found + word.length;
  }

  let previous = 0;
  let next = 0;
  return sentences.map((sentence) => {
    while (next < positions.length && positions[next].index < sentence.start) next += 1;
    const first = positions[next];
    const startMs = first && first.index < sentence.end ? first.offsetMs : previous;
    previous = startMs;
    return { ...sentence, startMs };
  });
}

/**
 * Which sentence is being spoken at `elapsedMs`. Returns 0 before the first
 * sentence starts, so playback that has begun always highlights something.
 */
export function sentenceIndexAt(sentences: TimedSentence[], elapsedMs: number): number {
  let index = 0;
  for (let candidate = 0; candidate < sentences.length; candidate += 1) {
    if (sentences[candidate].startMs > elapsedMs) break;
    index = candidate;
  }
  return index;
}
