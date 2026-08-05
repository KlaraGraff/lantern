export type PassiveVocabStyle = "ruby" | "margin";
export type PassiveVocabDensity = "low" | "medium" | "high";

export interface PassiveVocabSettings {
  enabled: boolean;
  style: PassiveVocabStyle;
  density: PassiveVocabDensity;
}

export interface PassiveVocabCandidate {
  cfi: string;
  definition?: string | null;
  mastery?: string | null;
}

export interface PassiveVocabDomAnnotation {
  cfi: string;
  label: string;
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
  "passive_vocab_density",
] as const;

export const PASSIVE_VOCAB_CFI_TRANSPARENT_ATTRIBUTE = "data-cfi-transparent";

const PASSIVE_VOCAB_ROOT_ATTRIBUTE = "data-passive-vocab-root";
const PASSIVE_VOCAB_RAIL_ATTRIBUTE = "data-passive-vocab-margin-rail";
const PASSIVE_VOCAB_LABEL_ATTRIBUTE = "data-passive-vocab-margin-label";
const PASSIVE_VOCAB_RUBY_TEXT_ATTRIBUTE = "data-passive-vocab-ruby-text";
const PASSIVE_VOCAB_OVERFLOW_ATTRIBUTE = "data-passive-vocab-margin-overflow";

export function parsePassiveVocabSettings(settings: Record<string, string>): PassiveVocabSettings {
  return {
    enabled: settings.passive_vocab_enabled === "true",
    style: settings.passive_vocab_style === "margin" ? "margin" : "ruby",
    density: settings.passive_vocab_density === "low" || settings.passive_vocab_density === "high"
      ? settings.passive_vocab_density
      : "medium",
  };
}

export function passiveVocabLabel(definition: string | null | undefined) {
  const plain = (definition ?? "").replace(/\s+/g, " ").trim();
  const limit = 16;
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

/**
 * A predictable teaching order: words in active learning come first, then
 * unseen words, then everything else. CFI breaks ties so the same book state
 * always produces the same annotations without random-looking hash sampling.
 */
export function passiveVocabLearningPriority(word: Pick<PassiveVocabCandidate, "mastery" | "cfi">) {
  if (word.mastery === "learning") return 0;
  if (word.mastery === "new" || !word.mastery) return 1;
  return 2;
}

export function passiveVocabCount(total: number, density: PassiveVocabDensity) {
  if (total <= 0) return 0;
  if (density === "high") return total;
  return Math.max(1, Math.ceil(total * (density === "medium" ? 0.5 : 0.25)));
}

/** Select the saved words that may be annotated, in deterministic learning order. */
export function selectPassiveVocab<T extends PassiveVocabCandidate>(
  words: Iterable<T>,
  density: PassiveVocabDensity,
) {
  const eligible = [...words].filter((word) => Boolean(word.cfi) && Boolean(passiveVocabLabel(word.definition)));
  eligible.sort((left, right) => (
    passiveVocabLearningPriority(left) - passiveVocabLearningPriority(right)
    || left.cfi.localeCompare(right.cfi)
  ));
  return new Set(eligible.slice(0, passiveVocabCount(eligible.length, density)).map((word) => word.cfi));
}

/**
 * Compatibility predicate for callers that already selected a CFI list. New
 * callers should use selectPassiveVocab so density can honour learning state.
 */
export function shouldShowPassiveVocab(cfi: string, density: PassiveVocabDensity, selected?: ReadonlySet<string>) {
  return density === "high" || selected?.has(cfi) === true;
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
  return {
    previous,
    next,
    values: {
      passive_vocab_enabled: String(next.enabled),
      passive_vocab_style: next.style,
      passive_vocab_density: next.density,
    },
  };
}

export function rollbackPassiveVocabSettings(
  current: PassiveVocabSettings,
  mutation: PassiveVocabSettingsMutation,
) {
  return current.enabled === mutation.next.enabled
    && current.style === mutation.next.style
    && current.density === mutation.next.density
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
  for (const annotation of annotations) {
    const range = resolveRange(annotation.cfi);
    if (!range || range.collapsed || !annotation.label) continue;
    try {
      if (useMargin) {
        installMargin(doc, range, annotation.label, idForAnnotation(index), rails, occupiedBottom, overflow, spread);
      } else {
        installRuby(doc, range, annotation.label);
      }
      index += 1;
    } catch {
      // A malformed CFI or a partially-unwrappable range must never block the
      // rest of the reader's document from loading.
    }
  }
  if (useMargin) installMarginOverflowBadges(doc, rails, overflow);
  return () => cleanupPassiveVocabAnnotations(doc);
}

/** Remove all injected notes and restore each annotation's original content. */
export function cleanupPassiveVocabAnnotations(doc: Document) {
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
}
