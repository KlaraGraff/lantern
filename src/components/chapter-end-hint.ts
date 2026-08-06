/**
 * The one line a chapter is allowed to say about itself: how many saved words
 * showed up in it, with a way to go review them and a way to make the line
 * stop appearing. No React, no Tauri — same discipline as passive-vocab.ts,
 * because this has to run inside a Foliate content document's own `Document`,
 * not the host window's.
 *
 * Placement is the whole point: this installs at the very end of `doc.body`,
 * after the chapter's last block, so in paginated mode it only ever lands on
 * the section's final page. A reader who never reaches the end of the chapter
 * never sees it — that is deliberate, not a gap to fix.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The line's own container, and the cleanup selector's anchor. */
const ROOT_ATTRIBUTE = "data-lantern-chapter-end";
/** The visibility rules injected into `doc.head`; removed alongside the line. */
const STYLE_ATTRIBUTE = "data-lantern-chapter-end-style";
/** The "don't show again" control, targeted by the hover-reveal CSS below. */
const DISMISS_ATTRIBUTE = "data-lantern-chapter-end-dismiss";

export interface ChapterEndHintOptions {
  doc: Document;
  lookupCount: number;
  /** Pre-translated by the caller — this module has no i18n of its own. */
  text: { line: string; action: string; dismiss: string };
  /** The reader's resolved paper palette, not the host stylesheet's CSS vars — those don't reach inside the iframe. */
  color: { muted: string; rule: string };
  onReview: () => void;
  onDismiss: () => void;
}

/**
 * Whether a chapter-end hint belongs on screen at all. Pulled out as its own
 * predicate so the two suppression rules — the setting being off, and a
 * chapter with nothing to review — are each testable without touching the DOM.
 */
export function shouldShowChapterEndHint(enabled: boolean, lookupCount: number): boolean {
  return enabled && lookupCount > 0;
}

function buildRefreshIcon(doc: Document, stroke: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", stroke);
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const arc = doc.createElementNS(SVG_NS, "path");
  arc.setAttribute("d", "M3 12a9 9 0 1 0 3-6.7L3 8");
  const arrow = doc.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M3 3v5h5");
  svg.append(arc, arrow);
  return svg;
}

function buildCloseIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  // Inherits the dismiss button's own colour rather than repeating it, so the
  // icon and its label can never drift apart into two different greys.
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const cross = doc.createElementNS(SVG_NS, "path");
  cross.setAttribute("d", "M18 6 6 18M6 6l12 12");
  svg.append(cross);
  return svg;
}

/**
 * Installs the chapter-end review line into one Foliate content document.
 * Idempotent — always clears whatever this module previously installed in
 * `doc` first, so a re-render (a settings change, a re-resolved word count)
 * never leaves two lines stacked on top of each other. Passing a non-positive
 * `lookupCount` is a no-op past the cleanup: there is nothing to review, so
 * there is nothing to say.
 */
export function installChapterEndHint(options: ChapterEndHintOptions): void {
  const { doc, lookupCount, text, color, onReview, onDismiss } = options;
  cleanupChapterEndHint(doc);
  if (lookupCount <= 0) return;

  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  // Host CSS cannot reach into the iframe, so the hover/focus reveal has to
  // ship as a rule inside the document it targets.
  style.textContent = `
    [${ROOT_ATTRIBUTE}] [${DISMISS_ATTRIBUTE}] { opacity: 0; transition: opacity .15s ease; }
    [${ROOT_ATTRIBUTE}]:hover [${DISMISS_ATTRIBUTE}] { opacity: 1; }
    [${ROOT_ATTRIBUTE}] [${DISMISS_ATTRIBUTE}]:focus-visible { opacity: 1; }
  `;
  doc.head.append(style);

  const sansFamily = "system-ui, -apple-system, sans-serif";

  const row = doc.createElement("div");
  row.setAttribute(ROOT_ATTRIBUTE, "");
  Object.assign(row.style, {
    marginTop: "34px",
    paddingTop: "22px",
    borderTop: `1px solid ${color.rule}`,
    display: "flex",
    alignItems: "center",
    gap: "9px",
    flexWrap: "wrap",
  });
  row.append(buildRefreshIcon(doc, color.muted));

  const line = doc.createElement("span");
  Object.assign(line.style, { fontSize: "13px", color: color.muted, fontFamily: sansFamily });
  line.textContent = text.line;
  row.append(line);

  // A <button> styled as a link, never an `<a href="#">`. foliate-js installs
  // its own listener on the whole content document that intercepts any click
  // landing inside an `a[href]` and routes the href through `view.goTo()`.
  // That listener never checks `defaultPrevented`, so an anchor here made one
  // click do two things: run this handler *and* make the renderer jump. With
  // "go review" that jump hits a view the host is already tearing down, and
  // WebKit dereferences the dead scrolling tree on its next display refresh —
  // a hard crash of the whole app, not a JS error.
  const action = doc.createElement("button");
  action.setAttribute("type", "button");
  Object.assign(action.style, {
    fontSize: "13px",
    color: color.muted,
    background: "transparent",
    border: "none",
    padding: "0",
    cursor: "pointer",
    // The same hairline the row's top border uses, rather than the mockup's
    // literal rgba(0,0,0,.14): the reader ships dark paper themes, and a
    // black underline on dark paper is no underline at all.
    borderBottom: `1px solid ${color.rule}`,
    paddingBottom: "1px",
    fontFamily: sansFamily,
  });
  action.textContent = text.action;
  action.addEventListener("click", (event) => {
    event.preventDefault();
    // This row is host chrome that happens to live in the book's document, not
    // book content — foliate's document-level handlers have no business seeing
    // its clicks at all.
    event.stopPropagation();
    onReview();
  });
  row.append(action);

  // A real <button>, not a styled span: it must be reachable by keyboard even
  // though it stays visually hidden until the pointer (or focus) is over the
  // line — see the injected <style> above.
  const dismiss = doc.createElement("button");
  dismiss.setAttribute("type", "button");
  dismiss.setAttribute(DISMISS_ATTRIBUTE, "");
  dismiss.setAttribute("aria-label", text.dismiss);
  Object.assign(dismiss.style, {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: color.muted,
    background: "transparent",
    border: "none",
    padding: "0",
    cursor: "pointer",
    fontFamily: sansFamily,
  });
  const dismissLabel = doc.createElement("span");
  dismissLabel.textContent = text.dismiss;
  dismiss.append(dismissLabel, buildCloseIcon(doc));
  // No confirmation: interrupting someone to confirm they want to hide one
  // line of small text is a worse interruption than the line ever was.
  dismiss.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  });
  row.append(dismiss);

  doc.body.append(row);
}

/** Removes whatever `installChapterEndHint` last put into `doc`, if anything. */
export function cleanupChapterEndHint(doc: Document): void {
  doc.querySelectorAll(`[${ROOT_ATTRIBUTE}]`).forEach((node) => node.remove());
  doc.querySelectorAll(`[${STYLE_ATTRIBUTE}]`).forEach((node) => node.remove());
}
