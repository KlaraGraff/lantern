/**
 * Did a reflow move the reader off the line they were on?
 *
 * Anything that changes the viewer's size — the window resizing, a side panel
 * dragging, a reduced-motion change — makes the paginator re-columnize, and a
 * re-columnized book puts different text on the page. Foliate re-anchors to the
 * range it last saw, but that anchor is a whole visible *range*: when the new
 * columns are shorter, the range no longer fits and the page it lands on can
 * start somewhere else entirely. To the reader that is a jump, with no gesture
 * behind it.
 *
 * So compare the location CFI before and after the relayout and, when it moved,
 * navigate back. Only the *start* of the location is compared: the end moves on
 * every reflow by definition (that is what "the page holds different text" is),
 * and treating that as a jump would make every resize navigate.
 */

/**
 * The start half of a location CFI, as a comparable string.
 *
 * A visible-range CFI has the form `epubcfi(parent,start,end)`; this joins the
 * parent to the start and drops the end. The result is only ever compared with
 * another of its own kind, so it does not have to be a re-parsable CFI. A
 * non-range CFI has no top-level comma and comes back unchanged.
 *
 * Two CFI escaping rules have to be honoured or the split lands in the wrong
 * place: `^` escapes the next character, and a text-location assertion
 * (`[pre,post]`) may itself contain commas.
 */
export function cfiStart(cfi: string): string {
  const open = cfi.indexOf("(");
  const inner = open >= 0 && cfi.endsWith(")")
    ? cfi.slice(open + 1, -1)
    : cfi;
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let at = 0; at < inner.length; at += 1) {
    const character = inner[at];
    if (character === "^") {
      current += character + (inner[at + 1] ?? "");
      at += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.length >= 2 ? parts[0] + parts[1] : inner;
}

/**
 * Whether the location visibly moved across a relayout.
 *
 * A missing reading on either side means nothing to compare — no book open yet,
 * or the relayout produced no `relocate` — and is never reported as a move: a
 * blind restore would be a jump of its own.
 */
export function movedDuringReflow(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  if (!before || !after) return false;
  return cfiStart(before) !== cfiStart(after);
}
