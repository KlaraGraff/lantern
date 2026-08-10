/**
 * When a single click on a word counts as reading the dictionary.
 *
 * The free definition strip at the top of the reader's context menu feeds the
 * mastery engine at half the weight of an AI learning card (migration 069,
 * `docs/impls/dictionary-glance-mastery.md`). Half a demotion is still a
 * demotion, so the bar for "the reader actually read it" has to be high: a
 * real entry rendered, the menu stayed open a beat afterwards, and the click
 * was not on its way to some other action.
 *
 * Framework-free so the rule can be unit-tested without a DOM — the component
 * (`ReaderContextMenu`) owns only the timer and the event plumbing.
 */

/**
 * How long the entry has to stay on screen. Long enough that a menu opened and
 * dismissed in one motion never counts, short enough that reading two senses
 * does. Deliberately far above the 700 ms the exposure engine uses for a word
 * merely being looked at: this one costs the reader mastery.
 */
export const GLANCE_DWELL_MS = 1500;

/**
 * Marks a menu control that does *not* spend the glance. Only 展开全部 / 收起
 * carries it: expanding the entry is reading more of the definition, which is
 * the glance itself, not a detour away from it. Everything else with
 * `role="menuitem"` — including the pronounce button the dictionary card hosts
 * — counts as the reader having gone somewhere else.
 */
export const GLANCE_SAFE_ATTR = "data-glance-safe";

/** One click's running account, mutated in place while the menu is open. */
export interface GlanceAttempt {
  /** The gloss the reader had in front of them. Empty until an entry renders. */
  definition: string;
  /** The entry stayed on screen for {@link GLANCE_DWELL_MS}. */
  dwelt: boolean;
  /** A menu action was taken, so this click was a means to something else. */
  spent: boolean;
}

export function newGlanceAttempt(): GlanceAttempt {
  return { definition: "", dwelt: false, spent: false };
}

/**
 * Whether the account settles as a countable glance. Read at menu close, never
 * earlier: the third condition — that nothing else was clicked — is not
 * knowable until the menu is gone.
 */
export function glanceCounts(attempt: GlanceAttempt): boolean {
  return attempt.dwelt && !attempt.spent;
}

/** One node on the path from the clicked element up to the menu root. */
export interface GlanceClickNode {
  /** Carries `role="menuitem"` — a row or control the reader activated. */
  isMenuItem: boolean;
  /** Carries {@link GLANCE_SAFE_ATTR}. */
  glanceSafe: boolean;
}

/**
 * Whether a click inside the menu spends the glance, given the ancestor chain
 * from the clicked node outwards (closest first).
 *
 * Nearest wins, so a control can opt out for everything inside it — the
 * 展开全部 button's own label and icon are part of the button, not separate
 * clicks. A click that reaches the menu root without passing through any
 * control (the card's text, the padding between rows) spends nothing.
 */
export function clickSpendsGlance(path: readonly GlanceClickNode[]): boolean {
  for (const node of path) {
    if (node.glanceSafe) return false;
    if (node.isMenuItem) return true;
  }
  return false;
}

/** The shape of `DictionaryEntry` this module needs, without importing React. */
export interface GlanceEntry {
  groups: { pos: string; senses: string[] }[];
  fallbackSummary: string | null;
}

/**
 * The definition text a glance reports, flattened out of the card's grouped
 * layout. A word filed into the watchlist by glances alone has never had an AI
 * card written for it, so this is the only gloss its row will carry until one
 * is.
 */
export function glanceDefinition(entry: GlanceEntry | null): string {
  if (!entry) return "";
  if (entry.fallbackSummary) return entry.fallbackSummary;
  return entry.groups
    .map((group) => [group.pos, group.senses.join("；")].filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join("  ");
}
