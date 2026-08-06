/**
 * The fallback for §2.2's auto-finish gate (docs/impls/reading-flow-decisions-2026-08-06.md).
 * When progress and coverage don't both clear the bar, the book is never
 * auto-marked finished and there is no popup either — "宁可漏标，不可错标" — this
 * one restrained line is the only thing that happens instead: "Read to here?
 * Mark as finished", with a way to act on it and a way to make it stop
 * appearing. No React, no Tauri — same discipline as chapter-end-hint.ts,
 * because this has to run inside a Foliate content document's own
 * `Document`, not the host window's.
 *
 * Placement mirrors chapter-end-hint.ts exactly: installs at the very end of
 * `doc.body`, so in paginated mode it only ever lands on that section's
 * final page. It is the caller's job to only invoke this for the book's
 * last loaded section — this module has no notion of "which section is
 * last", it just decorates whichever document it's given.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The line's own container, and the cleanup selector's anchor. */
const ROOT_ATTRIBUTE = "data-lantern-book-finished";
/** The visibility rules injected into `doc.head`; removed alongside the line. */
const STYLE_ATTRIBUTE = "data-lantern-book-finished-style";
/** The "don't show again" control, targeted by the hover-reveal CSS below. */
const DISMISS_ATTRIBUTE = "data-lantern-book-finished-dismiss";

export interface BookFinishedHintOptions {
  doc: Document;
  /** Pre-translated by the caller — this module has no i18n of its own. */
  text: { line: string; action: string; dismiss: string };
  /** The reader's resolved paper palette, not the host stylesheet's CSS vars — those don't reach inside the iframe. */
  color: { muted: string; rule: string };
  onMarkFinished: () => void;
  onDismiss: () => void;
}

function buildCheckIcon(doc: Document, stroke: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", stroke);
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const check = doc.createElementNS(SVG_NS, "path");
  check.setAttribute("d", "M20 6 9 17l-5-5");
  svg.append(check);
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
 * Installs the "mark as finished?" line into one Foliate content document.
 * Idempotent — always clears whatever this module previously installed in
 * `doc` first, so a re-render (a settings change, a re-resolved status)
 * never leaves two lines stacked on top of each other.
 */
export function installBookFinishedHint(options: BookFinishedHintOptions): void {
  const { doc, text, color, onMarkFinished, onDismiss } = options;
  cleanupBookFinishedHint(doc);

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
  row.append(buildCheckIcon(doc, color.muted));

  const line = doc.createElement("span");
  Object.assign(line.style, { fontSize: "13px", color: color.muted, fontFamily: sansFamily });
  line.textContent = text.line;
  row.append(line);

  const action = doc.createElement("a");
  action.setAttribute("href", "#");
  Object.assign(action.style, {
    fontSize: "13px",
    color: color.muted,
    textDecoration: "none",
    // The same hairline the row's top border uses, rather than a literal
    // rgba(0,0,0,.14): the reader ships dark paper themes, and a black
    // underline on dark paper is no underline at all.
    borderBottom: `1px solid ${color.rule}`,
    paddingBottom: "1px",
    fontFamily: sansFamily,
  });
  action.textContent = text.action;
  action.addEventListener("click", (event) => {
    event.preventDefault();
    onMarkFinished();
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
    onDismiss();
  });
  row.append(dismiss);

  doc.body.append(row);
}

/** Removes whatever `installBookFinishedHint` last put into `doc`, if anything. */
export function cleanupBookFinishedHint(doc: Document): void {
  doc.querySelectorAll(`[${ROOT_ATTRIBUTE}]`).forEach((node) => node.remove());
  doc.querySelectorAll(`[${STYLE_ATTRIBUTE}]`).forEach((node) => node.remove());
}
