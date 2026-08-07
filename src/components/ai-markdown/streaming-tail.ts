// While an answer is still streaming, inline markers arrive half-open:
// `==高亮` has no closing `==` yet, `**bo` no closing `**`, an alert tag may
// have streamed only `[!WAR`. Rendering those verbatim flashes raw markup at
// the reader and, worse, snaps the styling on a beat later. This settles the
// visible tail: half-arrived markers are hidden, opened spans are closed so
// their styling is stable from the first frame. Every adjustment is display
// only — the stored message is untouched, and once the stream completes the
// text renders as sent.

/** Marker pairs that must not appear unbalanced in the visible tail. */
const PAIRED_MARKERS = ["`", "**", "==", "~~"] as const;

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let at = text.indexOf(marker);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(marker, at + marker.length);
  }
  return count;
}

function settleMarker(tail: string, marker: string): string {
  if (countOccurrences(tail, marker) % 2 === 0) return tail;
  // Markdown will not close a span right after a space, so settle against the
  // trimmed tail; the hidden space reappears with the next chunk.
  const trimmed = tail.replace(/[ \t]+$/, "");
  // An opener with no content behind it yet: hide the marker itself.
  if (trimmed.endsWith(marker)) return trimmed.slice(0, -marker.length);
  // An opened span with content: close it so the styling holds steady.
  return trimmed + marker;
}

export function settleStreamingTail(text: string): string {
  if (!text) return text;

  // Inside an unclosed fenced code block everything is literal — the fence
  // itself already renders as a code block, and "fixing" markers inside it
  // would corrupt real code.
  const fences = text.match(/(?:^|\n)[ \t]{0,3}```/g);
  if (fences && fences.length % 2 === 1) return text;

  // A blockquote alert tag still arriving (`> [!WAR`): hide the whole line, so
  // the reader never sees "[!WAR" as quote text and never watches an empty
  // quote card reshape into a warning strip — the strip appears fully formed
  // once the tag has closed.
  const halfTag = /(?:^|\n)[ \t]{0,3}>[ \t]*\[![a-zA-Z]{0,12}$/.exec(text);
  if (halfTag) {
    const cut = halfTag.index + (text[halfTag.index] === "\n" ? 1 : 0);
    return text.slice(0, cut);
  }

  // Inline markers cannot cross a blank line; settle only the current block.
  const blockStart = text.lastIndexOf("\n\n") + 1;
  const head = text.slice(0, Math.max(blockStart, 0));
  let tail = text.slice(head.length);

  // A half-arrived double marker (`=` of a coming `==`, `*` of a `**`): drop
  // the lone character before balancing, or closing `==key=` would produce a
  // literal `===` run.
  const lone = /(^|[^=*~])([=*~])$/.exec(tail);
  if (lone) tail = tail.slice(0, -1);

  for (const marker of PAIRED_MARKERS) {
    tail = settleMarker(tail, marker);
  }

  return head + tail;
}
