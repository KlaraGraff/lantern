export type PassiveVocabStyle = "ruby" | "margin";

/**
 * How much of a word's annotation survives on the page. This is the reading
 * side of the mastery engine: a word the reader keeps meeting without looking
 * up climbs a tier, and its annotation quietly steps back one stage. The
 * annotation is the progress bar — nobody has to open a statistics screen.
 *
 * - `definition` — the gloss itself, hanging off the word (ruby or margin).
 * - `marker` — a hairline dotted underline. Tap it to see the gloss.
 * - `none` — nothing at all; the word is done.
 */
export type PassiveVocabStage = "definition" | "marker" | "none";

/** The two stages that actually draw something. */
export type PassiveVocabVisibleStage = Exclude<PassiveVocabStage, "none">;

export interface PassiveVocabSettings {
  enabled: boolean;
  style: PassiveVocabStyle;
  /**
   * How many *definitions* one screen may show. Markers are deliberately not
   * capped: a dotted underline on a word the reader nearly knows costs almost
   * nothing, and capping it would mean stage two disappears the moment a page
   * happens to carry a few freshly-looked-up words.
   */
  limit: number;
}

export const PASSIVE_VOCAB_MIN_LIMIT = 1;
export const PASSIVE_VOCAB_MAX_LIMIT = 10;
export const PASSIVE_VOCAB_DEFAULT_LIMIT = 3;

export interface PassiveVocabCandidate {
  cfi: string;
  definition?: string | null;
  mastery?: string | null;
}

export interface PassiveVocabDomAnnotation {
  cfi: string;
  label: string;
  /** Defaults to `definition` so a caller that has no mastery data still works. */
  stage?: PassiveVocabVisibleStage;
}

export interface PassiveVocabDomInstallOptions {
  doc: Document;
  annotations: Iterable<PassiveVocabDomAnnotation>;
  /** Resolves a stable EPUB CFI in this already-loaded Foliate document. */
  resolveRange: (cfi: string) => Range | null | undefined;
  style: PassiveVocabStyle;
  /** A margin rail needs room; compact windows deliberately use ruby instead. */
  narrowViewport?: boolean;
  /** In a spread, annotations use the outside edge of their physical page. */
  spread?: boolean;
}

/**
 * Below this viewport width there is no room for a margin rail, so the margin
 * style falls back to ruby. Shared with the reader's resize path so a window
 * that crosses the line re-installs in the other style instead of keeping
 * whatever it happened to open at.
 */
export const PASSIVE_VOCAB_NARROW_VIEWPORT_WIDTH = 760;

export function isNarrowPassiveVocabViewport(width: number) {
  return width < PASSIVE_VOCAB_NARROW_VIEWPORT_WIDTH;
}

export const PASSIVE_VOCAB_SETTING_KEYS = [
  "passive_vocab_enabled",
  "passive_vocab_style",
  "passive_vocab_limit",
] as const;

export const PASSIVE_VOCAB_CFI_TRANSPARENT_ATTRIBUTE = "data-cfi-transparent";

const PASSIVE_VOCAB_ROOT_ATTRIBUTE = "data-passive-vocab-root";
const PASSIVE_VOCAB_RAIL_ATTRIBUTE = "data-passive-vocab-margin-rail";
const PASSIVE_VOCAB_LABEL_ATTRIBUTE = "data-passive-vocab-margin-label";
const PASSIVE_VOCAB_RUBY_TEXT_ATTRIBUTE = "data-passive-vocab-ruby-text";
const PASSIVE_VOCAB_OVERFLOW_ATTRIBUTE = "data-passive-vocab-margin-overflow";
const PASSIVE_VOCAB_MARKER_ATTRIBUTE = "data-passive-vocab-marker";
const PASSIVE_VOCAB_MARKER_LABEL_ATTRIBUTE = "data-passive-vocab-marker-label";
const PASSIVE_VOCAB_POPOVER_ATTRIBUTE = "data-passive-vocab-popover";
const PASSIVE_VOCAB_STYLE_ATTRIBUTE = "data-passive-vocab-style";

/** Clamps a stored or stepped value into the range the settings screen offers. */
export function clampPassiveVocabLimit(value: number) {
  if (!Number.isFinite(value)) return PASSIVE_VOCAB_DEFAULT_LIMIT;
  return Math.min(PASSIVE_VOCAB_MAX_LIMIT, Math.max(PASSIVE_VOCAB_MIN_LIMIT, Math.round(value)));
}

export function parsePassiveVocabSettings(settings: Record<string, string>): PassiveVocabSettings {
  const stored = settings.passive_vocab_limit;
  return {
    enabled: settings.passive_vocab_enabled === "true",
    style: settings.passive_vocab_style === "margin" ? "margin" : "ruby",
    limit: stored ? clampPassiveVocabLimit(Number(stored)) : PASSIVE_VOCAB_DEFAULT_LIMIT,
  };
}

export function passiveVocabLabel(definition: string | null | undefined) {
  const plain = (definition ?? "").replace(/\s+/g, " ").trim();
  const limit = 16;
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

/**
 * Which of the three stages a word is in, read straight off its mastery tier.
 * A word with no tier yet is treated as new — it has just been saved, which is
 * exactly when its definition is worth the most.
 */
export function passiveVocabStage(mastery: string | null | undefined): PassiveVocabStage {
  if (mastery === "mastered") return "none";
  if (mastery === "familiar") return "marker";
  return "definition";
}

/**
 * A predictable teaching order within the definition stage: words in active
 * learning come first, then unseen words. CFI breaks ties so the same page
 * always annotates the same words instead of shuffling on every turn.
 */
export function passiveVocabLearningPriority(word: Pick<PassiveVocabCandidate, "mastery" | "cfi">) {
  if (word.mastery === "learning") return 0;
  if (word.mastery === "new" || !word.mastery) return 1;
  return 2;
}

/**
 * Works out what each saved word does on the page. Returns only the words that
 * draw something, keyed by CFI.
 *
 * The limit is a cap on definitions, and words past it show *nothing* rather
 * than falling back to a marker — a marker means "you nearly know this", so
 * hanging one on a word the reader just looked up would be a lie about their
 * own progress.
 */
export function selectPassiveVocab<T extends PassiveVocabCandidate>(
  words: Iterable<T>,
  limit: number,
) {
  const stages = new Map<string, PassiveVocabVisibleStage>();
  const glossable: T[] = [];
  for (const word of words) {
    if (!word.cfi || !passiveVocabLabel(word.definition)) continue;
    const stage = passiveVocabStage(word.mastery);
    if (stage === "none") continue;
    if (stage === "marker") stages.set(word.cfi, "marker");
    else glossable.push(word);
  }
  glossable.sort((left, right) => (
    passiveVocabLearningPriority(left) - passiveVocabLearningPriority(right)
    || left.cfi.localeCompare(right.cfi)
  ));
  for (const word of glossable.slice(0, Math.max(0, clampPassiveVocabLimit(limit)))) {
    stages.set(word.cfi, "definition");
  }
  return stages;
}

export interface PassiveVocabSettingsMutation {
  previous: PassiveVocabSettings;
  next: PassiveVocabSettings;
  values: Record<(typeof PASSIVE_VOCAB_SETTING_KEYS)[number], string>;
}

/** Pure optimistic-save state transition; callers can safely roll back only their own failed write. */
export function updatePassiveVocabSettings(
  previous: PassiveVocabSettings,
  patch: Partial<PassiveVocabSettings>,
): PassiveVocabSettingsMutation {
  const next = { ...previous, ...patch };
  if (patch.limit !== undefined) next.limit = clampPassiveVocabLimit(patch.limit);
  return {
    previous,
    next,
    values: {
      passive_vocab_enabled: String(next.enabled),
      passive_vocab_style: next.style,
      passive_vocab_limit: String(next.limit),
    },
  };
}

/** One piece of the state summary; `count` is present only where a number is interpolated. */
export interface PassiveVocabSummaryPart {
  key: string;
  count?: number;
}

/**
 * The one-line state summary shown under the master switch, as the i18n parts
 * that make it up. Off is a single part on its own — a summary that still
 * listed a style and a limit would read as if the feature were running.
 */
export function passiveVocabSummaryParts(value: PassiveVocabSettings): PassiveVocabSummaryPart[] {
  if (!value.enabled) return [{ key: "settings.passiveVocab.summaryOff" }];
  return [
    { key: "settings.passiveVocab.summaryOn" },
    { key: value.style === "margin" ? "settings.passiveVocab.styleMargin" : "settings.passiveVocab.styleRuby" },
    { key: "settings.passiveVocab.summaryLimit", count: value.limit },
  ];
}

export function formatPassiveVocabSummary(
  value: PassiveVocabSettings,
  translate: (key: string, params?: { count: number }) => string,
) {
  return passiveVocabSummaryParts(value)
    .map((part) => (part.count === undefined ? translate(part.key) : translate(part.key, { count: part.count })))
    .join(" · ");
}

export function rollbackPassiveVocabSettings(
  current: PassiveVocabSettings,
  mutation: PassiveVocabSettingsMutation,
) {
  return current.enabled === mutation.next.enabled
    && current.style === mutation.next.style
    && current.limit === mutation.next.limit
    ? mutation.previous
    : current;
}

function idForAnnotation(index: number) {
  return `lantern-passive-vocab-${index}`;
}

function transparentWrapper(doc: Document, range: Range, tag: "ruby" | "span") {
  const wrapper = doc.createElement(tag);
  wrapper.setAttribute(PASSIVE_VOCAB_ROOT_ATTRIBUTE, "");
  wrapper.setAttribute(PASSIVE_VOCAB_CFI_TRANSPARENT_ATTRIBUTE, "");
  const contents = range.extractContents();
  wrapper.append(contents);
  range.insertNode(wrapper);
  return wrapper;
}

function installRuby(doc: Document, range: Range, label: string) {
  const ruby = transparentWrapper(doc, range, "ruby");
  ruby.className = "lantern-passive-vocab-ruby";
  const rt = doc.createElement("rt");
  rt.setAttribute(PASSIVE_VOCAB_RUBY_TEXT_ATTRIBUTE, "");
  rt.textContent = label;
  ruby.append(rt);
}

/**
 * Stage two: the word keeps its own ink and gains a hairline dotted rule. The
 * gloss rides along in an attribute rather than in the DOM, so the paragraph's
 * text — and therefore every CFI resolved against it — is byte-for-byte what
 * the book shipped.
 */
function installMarker(doc: Document, range: Range, label: string) {
  const marker = transparentWrapper(doc, range, "span");
  marker.setAttribute(PASSIVE_VOCAB_MARKER_ATTRIBUTE, "");
  marker.setAttribute(PASSIVE_VOCAB_MARKER_LABEL_ATTRIBUTE, label);
  marker.setAttribute("role", "button");
  marker.setAttribute("tabindex", "0");
  marker.setAttribute("aria-expanded", "false");
  // The word itself is inside the wrapper, and `role="button"` would otherwise
  // hide it from assistive tech; naming the button "<word> — <gloss>" keeps
  // both readable without adding a node to the paragraph.
  const text = (marker.textContent ?? "").trim();
  marker.setAttribute("aria-label", text ? `${text} — ${label}` : label);
}

function markerStyleSheet(doc: Document) {
  const style = doc.createElement("style");
  style.setAttribute(PASSIVE_VOCAB_STYLE_ATTRIBUTE, "");
  // Host CSS cannot reach inside a section document's iframe, so the rules ship
  // as a sheet in the document they target. `currentColor` throughout: the
  // reader has five paper themes, and a fixed grey is wrong in at least three.
  style.textContent = `
    [${PASSIVE_VOCAB_MARKER_ATTRIBUTE}] {
      border-bottom: 1px dotted currentColor;
      border-bottom-color: color-mix(in srgb, currentColor 45%, transparent);
      cursor: pointer;
    }
    [${PASSIVE_VOCAB_MARKER_ATTRIBUTE}]:focus-visible {
      outline: 1px dotted currentColor;
      outline-offset: 2px;
    }
    [${PASSIVE_VOCAB_POPOVER_ATTRIBUTE}] {
      position: fixed;
      z-index: 4;
      max-width: 15em;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      background: var(--lantern-passive-vocab-paper, #fff);
      color: currentColor;
      font: 500 0.72em/1.3 system-ui, sans-serif;
      box-shadow: 0 6px 18px rgba(0, 0, 0, .16);
      overflow-wrap: anywhere;
      pointer-events: none;
    }
  `;
  return style;
}

/** The theme's actual paper colour, so the popover never floats on transparent. */
function paperColor(doc: Document) {
  try {
    const view = doc.defaultView;
    if (!view?.getComputedStyle) return "#fff";
    for (const element of [doc.body, doc.documentElement]) {
      const background = element && view.getComputedStyle(element).backgroundColor;
      if (background && background !== "transparent" && !/,\s*0\)$/.test(background)) return background;
    }
  } catch {
    // A document torn down mid-click; the fallback is still a readable chip.
  }
  return "#fff";
}

function closeMarkerPopover(doc: Document) {
  doc.querySelectorAll(`[${PASSIVE_VOCAB_POPOVER_ATTRIBUTE}]`).forEach((node) => node.remove());
  doc.querySelectorAll(`[${PASSIVE_VOCAB_MARKER_ATTRIBUTE}][aria-expanded="true"]`)
    .forEach((node) => node.setAttribute("aria-expanded", "false"));
}

function openMarkerPopover(doc: Document, marker: Element) {
  const label = marker.getAttribute(PASSIVE_VOCAB_MARKER_LABEL_ATTRIBUTE);
  if (!label) return;
  const rect = marker.getBoundingClientRect();
  const popover = doc.createElement("span");
  popover.setAttribute(PASSIVE_VOCAB_POPOVER_ATTRIBUTE, "");
  popover.setAttribute("role", "tooltip");
  popover.textContent = label;
  popover.style.setProperty("--lantern-passive-vocab-paper", paperColor(doc));
  doc.body.append(popover);
  const height = popover.getBoundingClientRect().height || 22;
  // Above the word by default, below it when the word sits at the very top of
  // the page and there is no room left over it.
  const above = rect.top - height - 6;
  popover.style.top = `${Math.round(above >= 4 ? above : rect.bottom + 6)}px`;
  popover.style.left = `${Math.round(Math.max(4, rect.left))}px`;
  marker.setAttribute("aria-expanded", "true");
}

function toggleMarkerPopover(doc: Document, marker: Element) {
  const wasOpen = marker.getAttribute("aria-expanded") === "true";
  // Always close first: only one gloss is ever on screen, so opening a second
  // marker puts the first one away rather than stacking two chips.
  closeMarkerPopover(doc);
  if (!wasOpen) openMarkerPopover(doc, marker);
}

/**
 * Per-document teardown for the marker listeners. Kept in a WeakMap rather than
 * on the returned cleanup closure because the reader also calls
 * `cleanupPassiveVocabAnnotations(doc)` directly, and that path has to unhook
 * the listeners too or every re-install would leave another pair behind.
 */
const markerTeardowns = new WeakMap<Document, () => void>();

function installMarkerBehaviour(doc: Document) {
  markerTeardowns.get(doc)?.();
  doc.head?.append(markerStyleSheet(doc));

  const findMarker = (target: EventTarget | null) => {
    const node = target as Element | null;
    return typeof node?.closest === "function"
      ? node.closest(`[${PASSIVE_VOCAB_MARKER_ATTRIBUTE}]`)
      : null;
  };

  // Capture phase, so a tap on a marker is consumed before Foliate's own
  // click handling turns the page out from under the gloss.
  const onClick = (event: Event) => {
    const marker = findMarker(event.target);
    if (!marker) {
      closeMarkerPopover(doc);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggleMarkerPopover(doc, marker);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeMarkerPopover(doc);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const marker = findMarker(event.target);
    if (!marker) return;
    event.preventDefault();
    event.stopPropagation();
    toggleMarkerPopover(doc, marker);
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown, true);
  markerTeardowns.set(doc, () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    markerTeardowns.delete(doc);
  });
}

function railSide(
  rect: DOMRect,
  doc: Document,
  spread: boolean,
  occupiedBottom: Map<"left" | "right", number>,
) {
  if (spread) {
    // The two physical pages in Foliate's spread share one viewport, side by
    // side. Whichever half the word's rect falls in is its physical page;
    // the far edge of that half is the page's outside rail.
    const viewport = doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
    return rect.left + rect.width / 2 < viewport / 2 ? "left" : "right";
  }
  // A single page has only one outside edge, so there is no page geometry to
  // split on. Instead balance load: send each new note to whichever rail has
  // accumulated less content so far, keeping both margins evenly filled.
  const left = occupiedBottom.get("left") ?? 0;
  const right = occupiedBottom.get("right") ?? 0;
  return left <= right ? "left" : "right";
}

function styleMarginRail(rail: HTMLElement, side: "left" | "right") {
  Object.assign(rail.style, {
    position: "fixed",
    top: "0",
    bottom: "0",
    width: "min(18vw, 176px)",
    pointerEvents: "none",
    zIndex: "2",
  });
  rail.style.left = side === "left" ? "0" : "";
  rail.style.right = side === "right" ? "0" : "";
}

function installMargin(
  doc: Document,
  range: Range,
  label: string,
  id: string,
  rails: Map<"left" | "right", HTMLElement>,
  occupiedBottom: Map<"left" | "right", number>,
  overflow: Map<"left" | "right", number>,
  spread: boolean,
) {
  const rect = range.getBoundingClientRect();
  const side = railSide(rect, doc, spread, occupiedBottom);
  const viewportHeight = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
  const top = Math.max(rect.top, occupiedBottom.get(side) ?? 4);
  // A note placed at or past the bottom edge would be invisible; count it as
  // dropped instead of silently rendering off-page.
  if (top >= viewportHeight - 4) {
    overflow.set(side, (overflow.get(side) ?? 0) + 1);
    return;
  }
  let rail = rails.get(side);
  if (!rail) {
    rail = doc.createElement("aside");
    rail.setAttribute(PASSIVE_VOCAB_RAIL_ATTRIBUTE, side);
    styleMarginRail(rail, side);
    doc.body.append(rail);
    rails.set(side, rail);
  }
  const wrapper = transparentWrapper(doc, range, "span");
  wrapper.className = "lantern-passive-vocab-anchor";
  wrapper.setAttribute("aria-describedby", id);
  const note = doc.createElement("span");
  note.id = id;
  note.setAttribute(PASSIVE_VOCAB_LABEL_ATTRIBUTE, "");
  note.setAttribute("role", "note");
  note.textContent = label;
  Object.assign(note.style, {
    position: "absolute",
    top: `${Math.round(top)}px`,
    left: "6px",
    right: "6px",
    // Inherits the reader theme's text colour, same as the ruby branch,
    // instead of a colour fixed to the light "paper" theme.
    color: "inherit",
    font: "500 0.72em/1.25 system-ui, sans-serif",
    overflowWrap: "anywhere",
  });
  rail.append(note);
  // ScrollHeight reflects a wrapped definition, avoiding overlap on the rail.
  occupiedBottom.set(side, top + Math.max(note.getBoundingClientRect().height, note.scrollHeight, 16) + 5);
}

function installMarginOverflowBadges(
  doc: Document,
  rails: Map<"left" | "right", HTMLElement>,
  overflow: Map<"left" | "right", number>,
) {
  for (const [side, count] of overflow) {
    if (count <= 0) continue;
    let rail = rails.get(side);
    if (!rail) {
      rail = doc.createElement("aside");
      rail.setAttribute(PASSIVE_VOCAB_RAIL_ATTRIBUTE, side);
      styleMarginRail(rail, side);
      doc.body.append(rail);
      rails.set(side, rail);
    }
    const badge = doc.createElement("span");
    badge.setAttribute(PASSIVE_VOCAB_OVERFLOW_ATTRIBUTE, "");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = `+${count}`;
    Object.assign(badge.style, {
      position: "absolute",
      bottom: "6px",
      left: side === "left" ? "6px" : "",
      right: side === "right" ? "6px" : "",
      color: "inherit",
      opacity: "0.7",
      font: "600 0.72em/1 system-ui, sans-serif",
    });
    rail.append(badge);
  }
}

/**
 * Installs real, layout-participating vocabulary annotations into one Foliate
 * content document. All wrappers are CFI-transparent, so saved locations keep
 * resolving after annotations are added or removed. Call the returned cleanup
 * before the document is discarded or before reapplying a changed selection.
 */
export function installPassiveVocabAnnotations(options: PassiveVocabDomInstallOptions) {
  const { doc, annotations, resolveRange, spread = false } = options;
  cleanupPassiveVocabAnnotations(doc);
  const useMargin = options.style === "margin" && !options.narrowViewport;
  const rails = new Map<"left" | "right", HTMLElement>();
  const occupiedBottom = new Map<"left" | "right", number>();
  const overflow = new Map<"left" | "right", number>();
  let index = 0;
  let markers = 0;
  for (const annotation of annotations) {
    const range = resolveRange(annotation.cfi);
    if (!range || range.collapsed || !annotation.label) continue;
    try {
      if (annotation.stage === "marker") {
        installMarker(doc, range, annotation.label);
        markers += 1;
      } else if (useMargin) {
        installMargin(doc, range, annotation.label, idForAnnotation(index), rails, occupiedBottom, overflow, spread);
        index += 1;
      } else {
        installRuby(doc, range, annotation.label);
        index += 1;
      }
    } catch {
      // A malformed CFI or a partially-unwrappable range must never block the
      // rest of the reader's document from loading.
    }
  }
  if (useMargin) installMarginOverflowBadges(doc, rails, overflow);
  // Only pay for the stylesheet and the two listeners on pages that actually
  // carry a marker.
  if (markers > 0) installMarkerBehaviour(doc);
  return () => cleanupPassiveVocabAnnotations(doc);
}

/** Remove all injected notes and restore each annotation's original content. */
export function cleanupPassiveVocabAnnotations(doc: Document) {
  markerTeardowns.get(doc)?.();
  doc.querySelectorAll<HTMLElement>(`[${PASSIVE_VOCAB_ROOT_ATTRIBUTE}]`).forEach((wrapper) => {
    const content = doc.createDocumentFragment();
    for (const child of [...wrapper.childNodes]) {
      // Foliate documents live in an iframe, so `instanceof HTMLElement` from
      // the host window is not reliable here.
      if (child.nodeType === 1 && (child as Element).hasAttribute(PASSIVE_VOCAB_RUBY_TEXT_ATTRIBUTE)) continue;
      content.append(child);
    }
    wrapper.replaceWith(content);
  });
  doc.querySelectorAll(`[${PASSIVE_VOCAB_RAIL_ATTRIBUTE}]`).forEach((rail) => rail.remove());
  doc.querySelectorAll(`[${PASSIVE_VOCAB_POPOVER_ATTRIBUTE}]`).forEach((node) => node.remove());
  doc.querySelectorAll(`[${PASSIVE_VOCAB_STYLE_ATTRIBUTE}]`).forEach((node) => node.remove());
}
