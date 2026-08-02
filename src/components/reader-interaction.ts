// Spelled with the extension, unlike the rest of the codebase, because the unit
// tests run this module through Node's type stripping, which resolves specifiers
// literally. `allowImportingTsExtensions` is already on, so tsc and Vite are
// happy either way; Node is not.
import { segmentSentences, type SentenceSpan } from "./speech/routing.ts";

export type InteractionKind = "word" | "phrase" | "passage";

export interface SerializableRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ReaderSelectionSnapshot {
  range: Range;
}

export interface ReaderInteraction {
  trigger: "word-menu" | "word-quick-lookup" | "selection-menu";
  kind: InteractionKind;
  text: string;
  normalizedText: string;
  context: string;
  location: string;
  anchorRect: SerializableRect;
  source: "foliate" | "text";
  format: "epub" | "pdf" | "text";
  locale?: string;
}

// EPUB content documents are parsed as XML (`application/xhtml+xml`), where
// `tagName` keeps the source casing — `"p"`, not `"P"` as in an HTML document.
// Comparing without normalising made every block-level lookup fail in a book,
// which is the only place these are used.
function isBlockElement(element: Element): boolean {
  return BLOCK_TAGS.has(element.tagName.toUpperCase());
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "H1", "H2", "H3", "H4",
  "H5", "H6", "SECTION", "ARTICLE", "ASIDE", "FIGCAPTION", "DT", "DD",
]);

export function normalizeInteractionText(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "")
    .toLocaleLowerCase();
}

export function classifySelection(value: string, locale?: string): InteractionKind {
  const text = value.trim();
  if (!text) return "passage";
  const words = segmentInteractionWords(text, locale);
  if (words.length === 1 && words[0].segment === text) return "word";
  if (words.length <= 5 && !/[.!?。！？；;:\n\r]/u.test(text)) return "phrase";
  return "passage";
}

const WORD_CONNECTOR = /^['’\-\u2010\u2011]$/u;

export interface InteractionWordSegment {
  segment: string;
  index: number;
}

export function segmentInteractionWords(text: string, locale?: string): InteractionWordSegment[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "word" },
    ) => { segment(value: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
  }).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(locale, { granularity: "word" });
    const parts = Array.from(segmenter.segment(text));
    const words: Array<{ segment: string; index: number }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part.isWordLike) continue;
      const start = part.index;
      let end = start + part.segment.length;
      while (
        index + 2 < parts.length
        && parts[index + 1].index === end
        && WORD_CONNECTOR.test(parts[index + 1].segment)
        && parts[index + 2].isWordLike
        && parts[index + 2].index === end + parts[index + 1].segment.length
      ) {
        end = parts[index + 2].index + parts[index + 2].segment.length;
        index += 2;
      }
      words.push({ segment: text.slice(start, end), index: start });
    }
    return words;
  }
  return Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-\u2010\u2011][\p{L}\p{M}\p{N}]+)*/gu))
    .map((match) => ({ segment: match[0], index: match.index ?? 0 }));
}

interface FlatTextEntry {
  node: Text;
  flatStart: number;
  flatEnd: number;
}

interface FlatTextRun {
  root: Element;
  text: string;
  entries: FlatTextEntry[];
}

interface DomPoint {
  node: Node;
  offset: number;
}

const INTERACTION_EXCLUSION_SELECTOR =
  "script,style,noscript,textarea,input,[contenteditable='true']";

function closestTextRunRoot(node: Node): Element | null {
  let element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  while (element && !isBlockElement(element)) element = element.parentElement;
  return element ?? node.ownerDocument?.body ?? node.ownerDocument?.documentElement ?? null;
}

function flattenTextRun(root: Element): FlatTextRun {
  const entries: FlatTextEntry[] = [];
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  let current = walker.nextNode();
  while (current) {
    if (
      current.nodeType === Node.ELEMENT_NODE
      && (current as Element).tagName.toUpperCase() === "BR"
      && closestTextRunRoot(current) === root
      && !(current as Element).closest(INTERACTION_EXCLUSION_SELECTOR)
    ) {
      text += "\n";
      current = walker.nextNode();
      continue;
    }
    if (current.nodeType !== Node.TEXT_NODE) {
      current = walker.nextNode();
      continue;
    }
    const node = current as Text;
    const value = node.data;
    if (
      value
      && !node.parentElement?.closest(INTERACTION_EXCLUSION_SELECTOR)
      && closestTextRunRoot(node) === root
    ) {
      const flatStart = text.length;
      text += value;
      entries.push({ node, flatStart, flatEnd: text.length });
    }
    current = walker.nextNode();
  }
  return { root, text, entries };
}

function compareDomPoints(first: DomPoint, second: DomPoint): number {
  if (first.node === second.node) return Math.sign(first.offset - second.offset);
  const doc = first.node.ownerDocument;
  if (!doc || doc !== second.node.ownerDocument) return 0;
  const firstRange = doc.createRange();
  const secondRange = doc.createRange();
  try {
    firstRange.setStart(first.node, first.offset);
    firstRange.collapse(true);
    secondRange.setStart(second.node, second.offset);
    secondRange.collapse(true);
    return firstRange.compareBoundaryPoints(Range.START_TO_START, secondRange);
  } catch {
    return 0;
  }
}

function domPointToFlatOffset(run: FlatTextRun, node: Node, offset: number): number | null {
  const direct = run.entries.find((entry) => entry.node === node);
  if (direct) {
    return direct.flatStart + Math.min(Math.max(0, offset), direct.node.length);
  }
  if (!run.root.contains(node) && node !== run.root) return null;
  const boundary = { node, offset };
  for (const entry of run.entries) {
    if (compareDomPoints(boundary, { node: entry.node, offset: 0 }) <= 0) {
      return entry.flatStart;
    }
    if (compareDomPoints(boundary, { node: entry.node, offset: entry.node.length }) <= 0) {
      return entry.flatEnd;
    }
  }
  return run.entries.length > 0 ? run.text.length : null;
}

function domPointAtFlatOffset(
  run: FlatTextRun,
  offset: number,
  edge: "start" | "end",
): DomPoint | null {
  const clamped = Math.min(Math.max(0, offset), run.text.length);
  const entry = edge === "start"
    ? run.entries.find((candidate, index) => (
      clamped < candidate.flatEnd
      || (clamped === candidate.flatStart && index === 0)
    )) ?? run.entries[run.entries.length - 1]
    : run.entries.find((candidate) => clamped <= candidate.flatEnd)
      ?? run.entries[run.entries.length - 1];
  if (!entry) return null;
  return {
    node: entry.node,
    offset: Math.min(entry.node.length, Math.max(0, clamped - entry.flatStart)),
  };
}

function rangeForFlatSegment(run: FlatTextRun, segment: InteractionWordSegment): Range {
  const range = run.root.ownerDocument.createRange();
  const start = domPointAtFlatOffset(run, segment.index, "start");
  const end = domPointAtFlatOffset(run, segment.index + segment.segment.length, "end");
  if (!start || !end) {
    range.selectNodeContents(run.root);
    range.collapse(true);
    return range;
  }
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function pointIntersectsRange(range: Range, x: number, y: number): boolean {
  return Array.from(range.getClientRects()).some((rect) => (
    rect.width > 0
    && rect.height > 0
    && x >= rect.left - 0.5
    && x <= rect.right + 0.5
    && y >= rect.top - 0.5
    && y <= rect.bottom + 0.5
  ));
}

function caretRangeAtPoint(doc: Document, x: number, y: number): Range | null {
  const caretDocument = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDocument.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = doc.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return caretDocument.caretRangeFromPoint?.(x, y) ?? null;
}

export function wordRangeAtPoint(
  doc: Document,
  x: number,
  y: number,
  locale?: string,
): Range | null {
  const caret = caretRangeAtPoint(doc, x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const root = closestTextRunRoot(caret.startContainer);
  if (!root) return null;
  const run = flattenTextRun(root);
  const offset = domPointToFlatOffset(run, caret.startContainer, caret.startOffset);
  if (offset === null) return null;

  const segments = segmentInteractionWords(run.text, locale);
  const direct = segments.find(({ segment, index }) => (
    offset >= index && offset < index + segment.length
  ));
  if (direct) {
    const range = rangeForFlatSegment(run, direct);
    if (pointIntersectsRange(range, x, y)) return range;
    // Caret APIs snap to the nearest insertion point, so blank space beside or
    // below a line resolves to a word the pointer never touched. Only accept a
    // word the pointer is geometrically inside.
    if (offset !== direct.index) return null;
    const previous = segments.find(({ segment, index }) => index + segment.length === offset);
    if (!previous) return null;
    const previousRange = rangeForFlatSegment(run, previous);
    return pointIntersectsRange(previousRange, x, y) ? previousRange : null;
  }

  // Clicking the right half of the final glyph lands exactly at the word end;
  // accept that word only when the pointer is still inside its rendered range.
  const previous = segments.find(({ segment, index }) => index + segment.length === offset);
  if (!previous) return null;
  const previousRange = rangeForFlatSegment(run, previous);
  return pointIntersectsRange(previousRange, x, y) ? previousRange : null;
}

/** Trailing whitespace belongs to the gap between sentences, not the selection. */
function trimmedSpanLength(text: string, span: SentenceSpan): number {
  return text.slice(span.start, span.end).trimEnd().length;
}

/**
 * Sentences inside `text[from..to)`, in `text`'s own coordinates and with
 * trailing whitespace dropped.
 *
 * Split out from the DOM walk because this is the part that can be subtly wrong:
 * the segmenter works on the slice, so every offset it reports has to be shifted
 * back, and a sentence that is only whitespace has to disappear rather than
 * become an empty range.
 */
export function sentenceSpansInSlice(
  text: string,
  from: number,
  to: number,
  locale?: string,
): SentenceSpan[] {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const spans: SentenceSpan[] = [];
  for (const span of segmentSentences(text.slice(start, end), locale)) {
    const spanStart = start + span.start;
    const length = trimmedSpanLength(text, { ...span, start: spanStart, end: start + span.end });
    if (length === 0) continue;
    spans.push({
      text: text.slice(spanStart, spanStart + length),
      start: spanStart,
      end: spanStart + length,
    });
  }
  return spans;
}

/**
 * The sentence under the pointer, for triple-click.
 *
 * Replaces the browser's select-the-paragraph default because picking out one
 * sentence is the common intent while reading. It also crosses pages for free:
 * pagination is CSS columns over one continuous document, so the block element
 * this walks is whole regardless of where the page break falls, and the second
 * half of a sentence the user cannot drag onto is still reachable.
 */
export function sentenceRangeAtPoint(
  doc: Document,
  x: number,
  y: number,
  locale?: string,
): Range | null {
  const caret = caretRangeAtPoint(doc, x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const root = closestTextRunRoot(caret.startContainer);
  if (!root) return null;
  const run = flattenTextRun(root);
  const offset = domPointToFlatOffset(run, caret.startContainer, caret.startOffset);
  if (offset === null) return null;

  const spans = segmentSentences(run.text, locale);
  const span = spans.find((candidate) => offset >= candidate.start && offset < candidate.end)
    // Safari 15 has no `Array.prototype.at`.
    ?? (spans.length > 0 ? spans[spans.length - 1] : undefined);
  if (!span) return null;

  const length = trimmedSpanLength(run.text, span);
  if (length === 0) return null;
  return rangeForFlatSegment(run, {
    segment: run.text.slice(span.start, span.start + length),
    index: span.start,
  });
}

/**
 * The whole block the point sits in — the paragraph, minus its surrounding
 * whitespace.
 *
 * The browser's own triple-click selects the same block, but it takes the raw
 * node contents: the newline and indentation an EPUB's source has between tags
 * come along with it, and a selection that ends in whitespace draws a trailing
 * bar past the end of the text. Going through the flattened run keeps the
 * boundaries on real characters, and keeps the result the same shape as what
 * `sentenceRangeAtPoint` returns.
 */
export function paragraphRangeAtPoint(doc: Document, x: number, y: number): Range | null {
  const caret = caretRangeAtPoint(doc, x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const root = closestTextRunRoot(caret.startContainer);
  if (!root) return null;
  const run = flattenTextRun(root);
  const start = run.text.search(/\S/);
  if (start < 0) return null;
  const end = run.text.replace(/\s+$/u, "").length;
  return rangeForFlatSegment(run, { segment: run.text.slice(start, end), index: start });
}

/**
 * How much of the text a triple-click grabs.
 *
 * A sentence is the default because it is the unit a reader looks up, listens
 * to or translates. Whole paragraphs are the browser's own answer, and worth
 * keeping for anyone reading in longer strides.
 */
export type TripleClickScope = "sentence" | "paragraph";

export const TRIPLE_CLICK_SCOPES: readonly TripleClickScope[] = ["sentence", "paragraph"];

export function parseTripleClickScope(value: string | undefined): TripleClickScope {
  return value === "paragraph" ? "paragraph" : "sentence";
}

export function tripleClickRangeAtPoint(
  doc: Document,
  x: number,
  y: number,
  scope: TripleClickScope,
  locale?: string,
): Range | null {
  return scope === "paragraph"
    ? paragraphRangeAtPoint(doc, x, y)
    : sentenceRangeAtPoint(doc, x, y, locale);
}

/** A sentence inside a selection, and where it sits in the document. */
export interface SentenceRange {
  text: string;
  range: Range;
}

/** Block elements the range touches, in document order and without repeats. */
function textRunRootsInRange(range: Range): Element[] {
  const doc = range.startContainer.ownerDocument;
  const container = range.commonAncestorContainer;
  if (!doc) return [];
  if (container.nodeType === Node.TEXT_NODE) {
    const root = closestTextRunRoot(container);
    return root ? [root] : [];
  }

  const roots: Element[] = [];
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if ((node as Text).data.trim() && range.intersectsNode(node)) {
      const root = closestTextRunRoot(node);
      if (root && !roots.includes(root)) roots.push(root);
    }
    node = walker.nextNode();
  }
  return roots;
}

/**
 * The sentences a selection covers, each with its own range.
 *
 * This is what lets the reading highlight keep pace with the audio: the caller
 * cuts the sentences out of the DOM once, and both the synthesis chunks and the
 * highlight refer to that same list by index. Segmenting the audio text
 * separately would risk a different count and a highlight pointing at the wrong
 * sentence.
 *
 * A selection may span several paragraphs, so each block is flattened on its own
 * and clipped to the part of it the selection actually covers.
 */
export function sentenceRangesInRange(range: Range, locale?: string): SentenceRange[] {
  const sentences: SentenceRange[] = [];

  for (const root of textRunRootsInRange(range)) {
    const run = flattenTextRun(root);
    const from = root.contains(range.startContainer) || root === range.startContainer
      ? domPointToFlatOffset(run, range.startContainer, range.startOffset) ?? 0
      : 0;
    const to = root.contains(range.endContainer) || root === range.endContainer
      ? domPointToFlatOffset(run, range.endContainer, range.endOffset) ?? run.text.length
      : run.text.length;
    for (const span of sentenceSpansInSlice(run.text, from, to, locale)) {
      sentences.push({
        text: span.text,
        range: rangeForFlatSegment(run, { segment: span.text, index: span.start }),
      });
    }
  }

  return sentences;
}

/**
 * A lookup started inside app chrome — a learning card, an AI answer — rather
 * than in the book. There is no CFI to anchor it to, so it carries an empty
 * location: the card still reads its own surrounding sentence as context, but
 * position-bound actions (marking the page, occurrence highlights) stay off.
 */
export function detachedInteraction(
  range: Range | null,
  root: Node | null,
  trigger: ReaderInteraction["trigger"],
  locale?: string,
): ReaderInteraction | null {
  if (!range || !root || !root.contains(range.commonAncestorContainer)) return null;
  const text = range.toString().trim();
  const normalizedText = normalizeInteractionText(text);
  if (!text || !normalizedText) return null;
  return {
    trigger,
    kind: classifySelection(text, locale),
    text,
    normalizedText,
    context: contextForRange(range, text),
    location: "",
    anchorRect: viewportRectForRange(range),
    source: "text",
    format: "text",
    locale,
  };
}

/**
 * A lookup started inside a card that is itself about a book passage. When that
 * passage contains the word, it — not the card's own wording, which is often a
 * label or a fragment — is the context the answer should be about.
 *
 * The position is deliberately not inherited: it addresses the word the parent
 * card was opened on, not this one, so carrying it over would mark the wrong
 * occurrence and file the lookup at the wrong place in the book.
 */
export function withInheritedContext(
  interaction: ReaderInteraction,
  origin: ReaderInteraction | undefined,
): ReaderInteraction {
  const passage = origin?.context?.trim();
  if (!passage) return interaction;
  return passage.toLocaleLowerCase().includes(interaction.text.toLocaleLowerCase())
    ? { ...interaction, context: passage }
    : interaction;
}

export function selectedRange(doc: Document): Range | null {
  const selection = doc.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return range.toString().trim() ? range.cloneRange() : null;
}

export function snapshotSelectionRange(range: Range | null): ReaderSelectionSnapshot | null {
  if (!range) return null;
  return {
    range: range.cloneRange(),
  };
}

export function rangeFromSelectionSnapshotAtPoint(
  snapshot: ReaderSelectionSnapshot | null,
  x: number,
  y: number,
): Range | null {
  const containsPoint = Array.from(snapshot?.range.getClientRects() ?? []).some((rect) => (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  ));
  return containsPoint ? snapshot?.range.cloneRange() ?? null : null;
}

export function readerMenuActivationIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
  modified = false,
): number | null {
  if (modified || currentIndex >= 0 || itemCount <= 0) return null;
  return key === "Enter" || key === " " ? 0 : null;
}

export function readerMenuFocusIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
  shiftKey = false,
  modified = false,
): number | null {
  if (itemCount <= 0) return null;
  if (modified || (shiftKey && key !== "Tab")) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "Tab" && currentIndex < 0) return shiftKey ? itemCount - 1 : 0;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  if (currentIndex < 0) return key === "ArrowDown" ? 0 : itemCount - 1;
  return (currentIndex + (key === "ArrowDown" ? 1 : -1) + itemCount) % itemCount;
}

export const READER_CONTEXT_MENU_KEY_EVENT = "quill-reader-context-menu-key";

export interface ReaderContextMenuKeyDetail {
  key: string;
  shiftKey: boolean;
  modified: boolean;
  handled: boolean;
}

export function forwardReaderContextMenuKey(event: KeyboardEvent): boolean {
  const detail: ReaderContextMenuKeyDetail = {
    key: event.key,
    shiftKey: event.shiftKey,
    modified: event.altKey || event.ctrlKey || event.metaKey,
    handled: false,
  };
  window.dispatchEvent(new CustomEvent<ReaderContextMenuKeyDetail>(
    READER_CONTEXT_MENU_KEY_EVENT,
    { detail },
  ));
  return detail.handled;
}

export function replaceDocumentSelection(doc: Document, range: Range): void {
  const selection = doc.getSelection?.();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range.cloneRange());
}

export function expandRangeToWordBoundaries(range: Range, locale?: string): Range | null {
  if (range.collapsed || !/[\p{L}\p{M}\p{N}]/u.test(range.toString())) return null;
  const doc = range.startContainer.ownerDocument;
  if (!doc || doc !== range.endContainer.ownerDocument) return null;
  const startRoot = closestTextRunRoot(range.startContainer);
  const endRoot = closestTextRunRoot(range.endContainer);
  if (!startRoot || !endRoot) return null;
  const startRun = flattenTextRun(startRoot);
  const endRun = startRoot === endRoot ? startRun : flattenTextRun(endRoot);
  const startOffset = domPointToFlatOffset(startRun, range.startContainer, range.startOffset);
  const endOffset = domPointToFlatOffset(endRun, range.endContainer, range.endOffset);
  if (startOffset === null || endOffset === null) return null;

  const startSegment = segmentInteractionWords(startRun.text, locale).find(({ segment, index }) => (
    startOffset >= index && startOffset < index + segment.length
  ));
  const endSegment = segmentInteractionWords(endRun.text, locale).find(({ segment, index }) => (
    endOffset > index && endOffset <= index + segment.length
  ));
  const expanded = range.cloneRange();
  if (startSegment) {
    const point = domPointAtFlatOffset(startRun, startSegment.index, "start");
    if (point) expanded.setStart(point.node, point.offset);
  }
  if (endSegment) {
    const point = domPointAtFlatOffset(
      endRun,
      endSegment.index + endSegment.segment.length,
      "end",
    );
    if (point) expanded.setEnd(point.node, point.offset);
  }
  return expanded;
}

export function contextForRange(range: Range, fallback: string): string {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  while (node && node.nodeType === Node.ELEMENT_NODE && !isBlockElement(node as Element)) {
    node = node.parentNode;
  }
  const context = (node as Element | null)?.textContent?.trim() || fallback.trim();
  if (context.length <= 800) return context;
  const selected = range.toString().trim();
  const selectedIndex = context.indexOf(selected);
  if (selectedIndex < 0) return context.slice(0, 800);
  const start = Math.max(0, selectedIndex - 300);
  return context.slice(start, Math.min(context.length, start + 800));
}

export function serializableRect(rect: DOMRect | DOMRectReadOnly): SerializableRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function viewportRectForRange(range: Range): SerializableRect {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const fallback = range.getBoundingClientRect();
  const rect = rects.length > 0 ? {
    left: Math.min(...rects.map((value) => value.left)),
    top: Math.min(...rects.map((value) => value.top)),
    right: Math.max(...rects.map((value) => value.right)),
    bottom: Math.max(...rects.map((value) => value.bottom)),
  } : fallback;
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
  const frameRect = frame?.getBoundingClientRect();
  const left = rect.left + (frameRect?.left ?? 0);
  const top = rect.top + (frameRect?.top ?? 0);
  return {
    left,
    top,
    right: rect.right + (frameRect?.left ?? 0),
    bottom: rect.bottom + (frameRect?.top ?? 0),
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  };
}

export function isInteractiveReaderTarget(target: EventTarget | null): boolean {
  const node = target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  return Boolean(element?.closest("a,button,input,textarea,select,option,[contenteditable='true'],[role='button']"));
}

/**
 * Word markers are wrapped around the text rather than painted over it, so the
 * marker is exactly as tall as the word: an inline background covers the font
 * box, while anything painted over a range — a highlight overlay, an SVG rect —
 * is sized by the line box and grows with the line height.
 *
 * The wrapper carries `data-cfi-transparent`, which the reader engine's CFI
 * walker skips (see `skipTransparent` in `epubcfi.js`). Its children then index
 * as if they were the parent's own and the text it splits merges back into one
 * chunk, so stored highlights, bookmarks, and reading positions keep resolving
 * to the same place whether or not markers happen to be in the document.
 *
 * Nothing here may affect layout — no padding, no font change — or pages would
 * reflow as words get looked up.
 */
export const WORD_MARK_TAG = "quill-mark";
const CFI_TRANSPARENT_ATTRIBUTE = "data-cfi-transparent";
const MAX_WORD_MARKS = 20_000;

function wordMarkStyleElement(doc: Document, name: string): HTMLStyleElement {
  const styleId = `quill-word-mark-style-${name}`;
  const existing = doc.getElementById(styleId) as HTMLStyleElement | null;
  if (existing) return existing;
  const style = doc.createElement("style");
  style.id = styleId;
  (doc.head ?? doc.documentElement).appendChild(style);
  return style;
}

function clearWordMarks(doc: Document, name: string): void {
  const marks = doc.querySelectorAll(`${WORD_MARK_TAG}[data-quill-mark="${name}"]`);
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    // Merge the text back so later walks see one node again.
    parent.normalize();
  }
}

export function applyWordMarks(
  doc: Document,
  normalizedWords: Iterable<string>,
  name: string,
  root: Node | undefined,
  includeRange: ((word: string, range: Range) => boolean) | undefined,
  css: string,
): void {
  clearWordMarks(doc, name);
  wordMarkStyleElement(doc, name).textContent =
    `${WORD_MARK_TAG}[data-quill-mark="${name}"] { display: inline; ${css} }`;
  const words = new Set(
    Array.from(normalizedWords, (word) => normalizeInteractionText(word)).filter(Boolean),
  );
  if (words.size === 0) return;

  // The walk finishes before anything is wrapped: mutating the tree underneath
  // a live TreeWalker is how this kind of code usually goes wrong.
  const targets: Text[] = [];
  const walker = doc.createTreeWalker(root ?? doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || parent?.closest("script,style,noscript,textarea,input,[contenteditable='true']")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text);
  }

  const locale = doc.documentElement.lang || undefined;
  let marked = 0;
  for (const text of targets) {
    if (marked >= MAX_WORD_MARKS) break;
    const matches = segmentInteractionWords(text.data, locale)
      .filter((segment) => words.has(normalizeInteractionText(segment.segment)));
    // Right to left: wrapping splits the node, and every match still to come
    // sits in the untouched part before the split.
    for (let index = matches.length - 1; index >= 0 && marked < MAX_WORD_MARKS; index -= 1) {
      const segment = matches[index];
      const range = doc.createRange();
      range.setStart(text, segment.index);
      range.setEnd(text, segment.index + segment.segment.length);
      if (includeRange && !includeRange(normalizeInteractionText(segment.segment), range)) continue;
      const mark = doc.createElement(WORD_MARK_TAG);
      mark.setAttribute("data-quill-mark", name);
      mark.setAttribute(CFI_TRANSPARENT_ATTRIBUTE, "");
      try {
        range.surroundContents(mark);
        marked += 1;
      } catch {
        // A range the engine refuses to wrap is skipped rather than retried.
      }
    }
  }
}
