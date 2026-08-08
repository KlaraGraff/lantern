/**
 * The one line a chapter is allowed to say about itself: how many saved words
 * showed up in it, with a way to look at them without leaving the book and a
 * way to make the line stop appearing. No React, no Tauri — same discipline
 * as passive-vocab.ts, because this has to run inside a Foliate content
 * document's own `Document`, not the host window's.
 *
 * Placement is the whole point: this installs at the very end of `doc.body`,
 * after the chapter's last block, so in paginated mode it only ever lands on
 * the section's final page. A reader who never reaches the end of the chapter
 * never sees it — that is deliberate, not a gap to fix.
 *
 * Collapsed, this is a fact and a reversible verb: "you looked up 5 words" /
 * "take a look". Clicking it used to leave the book (`onReview`, straight to
 * the review board); it now expands in place instead — three things only:
 * the reason it's worth a look, the words themselves as outlined chips (never
 * filled — a hardcoded fill would clash with a reader-chosen paper colour),
 * and a link that still does what the old click used to do. There is no
 * flashcard mechanic in here: no right/wrong, no progress, nothing to score.
 * See docs/impls/chapter-end-recap-mockup.html for the full design record.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The line's own container, and the cleanup selector's anchor. */
const ROOT_ATTRIBUTE = "data-lantern-chapter-end";
/** The visibility rules injected into `doc.head`; removed alongside the line. */
const STYLE_ATTRIBUTE = "data-lantern-chapter-end-style";
/** The "don't show again" control, wherever it ends up living. */
const DISMISS_ATTRIBUTE = "data-lantern-chapter-end-dismiss";
/**
 * Marks the dismiss control only when it sits in the collapsed row, which is
 * the one placement that stays hidden until hover/focus (see the injected
 * <style> below). The touch placement inside the expanded panel never gets
 * this attribute, so it stays plainly visible — a hidden control nobody can
 * hover to reveal would just be a missing control.
 */
const DISMISS_HOVER_ATTRIBUTE = "data-lantern-chapter-end-dismiss-hover";

const SANS_FAMILY = "system-ui, -apple-system, sans-serif";
const SERIF_FAMILY = "Georgia, serif";

export interface ChapterEndHintWord {
  id: string;
  word: string;
}

export interface ChapterEndHintOptions {
  doc: Document;
  lookupCount: number;
  /** Already capped by the caller via `capPileChips` — at most a handful. */
  words: ChapterEndHintWord[];
  /** Pre-translated "+N" label for the overflow marker, or null when nothing overflowed. */
  overflowLabel: string | null;
  /** Pre-translated by the caller — this module has no i18n of its own. */
  text: {
    line: string;
    expand: string;
    collapse: string;
    reason: string;
    openInReview: string;
    dismiss: string;
  };
  /** The reader's resolved paper palette, not the host stylesheet's CSS vars — those don't reach inside the iframe. */
  color: { muted: string; rule: string };
  onReview: () => void;
  onDismiss: () => void;
  /** A chip was clicked — `chipElement` is that chip's own button, for anchoring the popup that opens over it. */
  onWordClick: (id: string, chipElement: HTMLElement) => void;
  /** Fired right after the panel's `display` flips, with the row itself as the anchor to scroll back into view. */
  onExpandChange: (expanded: boolean, root: HTMLElement) => void;
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
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
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
 * Builds the one "don't show again" control this line ever has — never two.
 * `installChapterEndHint` decides afterwards where it lives (the collapsed
 * row, revealed on hover, or the expanded panel, always visible) based on
 * pointer coarseness; both placements read and write the exact same setting.
 */
function buildDismissButton(doc: Document, label: string, onDismiss: () => void): HTMLButtonElement {
  const dismiss = doc.createElement("button");
  dismiss.setAttribute("type", "button");
  dismiss.setAttribute(DISMISS_ATTRIBUTE, "");
  dismiss.setAttribute("aria-label", label);
  Object.assign(dismiss.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: "inherit",
    background: "transparent",
    border: "none",
    padding: "0",
    cursor: "pointer",
    fontFamily: SANS_FAMILY,
    whiteSpace: "nowrap",
  });
  const dismissLabel = doc.createElement("span");
  dismissLabel.textContent = label;
  dismiss.append(dismissLabel, buildCloseIcon(doc));
  // No confirmation: interrupting someone to confirm they want to hide one
  // line of small text is a worse interruption than the line ever was.
  dismiss.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  });
  return dismiss;
}

/**
 * Installs the chapter-end review line into one Foliate content document.
 * Idempotent — always clears whatever this module previously installed in
 * `doc` first, so a re-render (a settings change, a re-resolved word count)
 * never leaves two lines stacked on top of each other. Passing a non-positive
 * `lookupCount` is a no-op past the cleanup: there is nothing to review, so
 * there is nothing to say — and that holds even if `words` is non-empty,
 * since the count is what governs visibility.
 */
export function installChapterEndHint(options: ChapterEndHintOptions): void {
  const { doc, lookupCount, words, overflowLabel, text, color, onReview, onDismiss, onWordClick, onExpandChange } = options;
  cleanupChapterEndHint(doc);
  if (lookupCount <= 0) return;

  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  // Host CSS cannot reach into the iframe, so the hover/focus reveal has to
  // ship as a rule inside the document it targets.
  style.textContent = `
    [${ROOT_ATTRIBUTE}] [${DISMISS_HOVER_ATTRIBUTE}] { opacity: 0; transition: opacity .15s ease; }
    [${ROOT_ATTRIBUTE}]:hover [${DISMISS_HOVER_ATTRIBUTE}] { opacity: 1; }
    [${ROOT_ATTRIBUTE}] [${DISMISS_HOVER_ATTRIBUTE}]:focus-visible { opacity: 1; }
  `;
  doc.head.append(style);

  // Touch has no hover, and the collapsed row is only 375px wide on a phone —
  // a third tap target squeezed in next to "take a look" would make the two
  // easy to fat-finger together. So on a coarse pointer the dismiss control
  // moves into the expanded panel instead, next to the review link, where a
  // reader who wants it has room to reach it deliberately.
  const coarsePointer = doc.defaultView?.matchMedia?.("(pointer: coarse)")?.matches ?? false;

  const row = doc.createElement("div");
  row.setAttribute(ROOT_ATTRIBUTE, "");
  Object.assign(row.style, {
    marginTop: "34px",
    paddingTop: "22px",
    borderTop: `1px solid ${color.rule}`,
    fontFamily: SANS_FAMILY,
    color: color.muted,
    // In paginated mode the section document is laid out in CSS columns, so
    // expanding the panel makes the body taller and the renderer re-columnises
    // around it. Without this the row's header stays on the page the reader is
    // looking at and the panel it just opened flows into the *next* column —
    // the row visibly expands into nothing. Keeping the row unbreakable means
    // an expansion that no longer fits moves the whole unit to the next column,
    // where the caller's post-expand `scrollToAnchor` can follow it.
    breakInside: "avoid",
    WebkitColumnBreakInside: "avoid",
  });

  const top = doc.createElement("div");
  Object.assign(top.style, { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" });
  top.append(buildRefreshIcon(doc, color.muted));

  const line = doc.createElement("span");
  Object.assign(line.style, { fontSize: "13px", lineHeight: "1.5" });
  line.textContent = text.line;
  top.append(line);

  // ─── The expanded panel: reason, chips, review link — nothing else. ───
  const panel = doc.createElement("div");
  Object.assign(panel.style, { marginTop: "13px", display: "none" });

  const reason = doc.createElement("p");
  Object.assign(reason.style, { fontSize: "11.8px", lineHeight: "1.6", margin: "0 0 10px", opacity: "0.9" });
  reason.textContent = text.reason;

  const chips = doc.createElement("div");
  Object.assign(chips.style, { display: "flex", flexWrap: "wrap", gap: "6px" });
  for (const word of words) {
    // A real <button>, not a styled span: the whole point of a chip is that
    // it opens the existing word-lookup card, and that has to be reachable by
    // keyboard the same as any other control on this line.
    const chip = doc.createElement("button");
    chip.setAttribute("type", "button");
    Object.assign(chip.style, {
      fontFamily: SERIF_FAMILY,
      fontWeight: "400",
      fontSize: "12.6px",
      letterSpacing: "0.2px",
      // Outlined, never filled: the reader can pick a custom paper colour, and
      // a hardcoded fill could turn into a stain on top of it. The border
      // colour is the one already resolved for this theme, so it never needs
      // its own case.
      border: `1px solid ${color.rule}`,
      borderRadius: "6px",
      padding: "2.5px 9px",
      lineHeight: "1.4",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    });
    chip.textContent = word.word;
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onWordClick(word.id, chip);
    });
    chips.append(chip);
  }
  if (overflowLabel) {
    const overflow = doc.createElement("i");
    Object.assign(overflow.style, {
      fontStyle: "normal",
      fontSize: "12.4px",
      padding: "3px 3px",
      opacity: "0.75",
      fontFamily: SERIF_FAMILY,
    });
    overflow.textContent = overflowLabel;
    chips.append(overflow);
  }

  const go = doc.createElement("div");
  Object.assign(go.style, {
    marginTop: "11px",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    flexWrap: "wrap",
    fontSize: "12.3px",
  });

  // A <button> styled as a link, never an `<a href="#">`. foliate-js installs
  // its own listener on the whole content document that intercepts any click
  // landing inside an `a[href]` and routes the href through `view.goTo()`.
  // That listener never checks `defaultPrevented`, so an anchor here made one
  // click do two things: run this handler *and* make the renderer jump. With
  // "go review" that jump hits a view the host is already tearing down, and
  // WebKit dereferences the dead scrolling tree on its next display refresh —
  // a hard crash of the whole app, not a JS error.
  const reviewLink = doc.createElement("button");
  reviewLink.setAttribute("type", "button");
  Object.assign(reviewLink.style, {
    fontSize: "inherit",
    color: "inherit",
    background: "transparent",
    border: "none",
    padding: "0",
    margin: "0",
    cursor: "pointer",
    fontFamily: "inherit",
    // The same hairline the row's top border uses, rather than a literal
    // black: the reader ships dark paper themes, and a black underline on
    // dark paper is no underline at all.
    borderBottom: `1px solid ${color.rule}`,
    paddingBottom: "1px",
  });
  reviewLink.textContent = text.openInReview;
  reviewLink.addEventListener("click", (event) => {
    event.preventDefault();
    // This row is host chrome that happens to live in the book's document, not
    // book content — foliate's document-level handlers have no business seeing
    // its clicks at all.
    event.stopPropagation();
    onReview();
  });
  go.append(reviewLink);

  const dismiss = buildDismissButton(doc, text.dismiss, onDismiss);
  Object.assign(dismiss.style, { marginLeft: "auto" });
  if (coarsePointer) {
    go.append(dismiss);
  } else {
    dismiss.setAttribute(DISMISS_HOVER_ATTRIBUTE, "");
    top.append(dismiss);
  }

  panel.append(reason, chips, go);

  // A real <button>, not a styled span: it must be reachable by keyboard even
  // though the line it's part of never moves. "⌄"/"⌃" are baked into the
  // translated strings themselves, same convention the retired action link
  // used for its own trailing arrow.
  const toggle = doc.createElement("button");
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-expanded", "false");
  Object.assign(toggle.style, {
    fontSize: "13px",
    color: "inherit",
    background: "transparent",
    border: "none",
    padding: "0 0 1px",
    cursor: "pointer",
    borderBottom: `1px solid ${color.rule}`,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  });
  toggle.textContent = text.expand;
  let expanded = false;
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    expanded = !expanded;
    panel.style.display = expanded ? "block" : "none";
    toggle.textContent = expanded ? text.collapse : text.expand;
    toggle.setAttribute("aria-expanded", String(expanded));
    onExpandChange(expanded, row);
  });
  top.append(toggle);

  row.append(top, panel);
  doc.body.append(row);
}

/** Removes whatever `installChapterEndHint` last put into `doc`, if anything. */
export function cleanupChapterEndHint(doc: Document): void {
  doc.querySelectorAll(`[${ROOT_ATTRIBUTE}]`).forEach((node) => node.remove());
  doc.querySelectorAll(`[${STYLE_ATTRIBUTE}]`).forEach((node) => node.remove());
}
