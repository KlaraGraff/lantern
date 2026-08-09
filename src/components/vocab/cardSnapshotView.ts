/**
 * Turns a stored `vocab_words.card_snapshot` blob into the list of modules a
 * vocabulary panel should draw, in the order the card drew them.
 *
 * The whole learning card has been captured on collect since migration 067,
 * but nothing ever read it back — the panel showed the two fields that have
 * their own columns and dropped the other nine modules the reader paid for.
 * This module is the "what is worth showing" half of fixing that.
 *
 * Nothing here imports React, i18n or Tauri (explicit `.ts` extensions, the
 * same as `cardSnapshot.ts` and `gloss.ts`) so the rules below can be asserted
 * in a plain `node --test` run.
 */
import { CARD_KIND_ORDER, MODULE_DEFINITIONS } from "../learning-card/config.ts";
import type {
  LearningCardKind,
  LearningModuleContent,
  LearningModuleId,
} from "../learning-card/types.ts";

/**
 * Modules the panel already prints above, from their own columns:
 * `context_meaning` is the contextual definition and `source_excerpt` is the
 * saved sentence. Redrawing them from the snapshot would double the panel's
 * height and add nothing to it.
 */
export const SKIPPED_SNAPSHOT_MODULES: readonly LearningModuleId[] = [
  "context_meaning",
  "source_excerpt",
];

export interface CardSnapshotModule {
  id: LearningModuleId;
  /** i18n key for the module's heading — `settings.tools.modules.<id>`. */
  labelKey: string;
  content: LearningModuleContent;
}

/**
 * Three outcomes, because the panel has three different things to say:
 *
 * - `none` — no snapshot, or nothing left worth drawing. The section does not
 *   appear at all; a greyed-out control on a word saved before the card
 *   existed is bad news invented out of nothing.
 * - `unreadable` — a snapshot was stored and cannot be parsed. This is the one
 *   case that speaks, because staying quiet here would be a lie: the row does
 *   hold something.
 * - `ready` — at least one module to draw. Never empty.
 */
export type CardSnapshotView =
  | { status: "none" }
  | { status: "unreadable" }
  | {
    status: "ready";
    kind: LearningCardKind;
    modules: CardSnapshotModule[];
    /**
     * When this card replaced an earlier one, in unix millis. Absent on every
     * card the collect path stored, which is what makes the panel's date
     * label honest without a migration: no stamp means the card is still the
     * one collected with the word.
     */
    refreshedAt?: number;
  };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a module holds anything at all. The model routinely returns a key
 * with an empty body for a module it had nothing to say about, and those must
 * not be counted — "还有 7 块" has to mean seven blocks the reader can read.
 *
 * Mirrors the card renderer's own emptiness test.
 */
export function hasModuleContent(content: unknown): content is LearningModuleContent {
  if (!isObject(content)) return false;
  const { heading, summary, quote, meta, details, items } = content as LearningModuleContent;
  return Boolean(
    (typeof heading === "string" && heading.trim())
    || (typeof summary === "string" && summary.trim())
    || (typeof quote === "string" && quote.trim())
    || (Array.isArray(meta) && meta.length > 0)
    || (Array.isArray(details) && details.length > 0)
    || (Array.isArray(items) && items.length > 0),
  );
}

/**
 * A card collected from a phrase or a passage stores that kind, and its
 * modules are a different set in a different order. Anything else — an older
 * blob, a hand-edited one — is read as a word card, which is what every
 * snapshot written by the lookup card actually is.
 */
function readKind(value: unknown): LearningCardKind {
  return CARD_KIND_ORDER.includes(value as LearningCardKind)
    ? (value as LearningCardKind)
    : "word";
}

/**
 * The regenerate path's own timestamp. Anything that is not a real moment —
 * missing, a string, zero, negative, NaN — reads as "never refreshed", which
 * falls the label back to the word's collection date rather than printing a
 * date derived from garbage.
 */
function readRefreshedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * @param json the raw `card_snapshot` column, as `get_vocab_card_snapshot`
 *   hands it back: the JSON of a `LearningCardResult`, or null.
 */
export function buildCardSnapshotView(json: string | null | undefined): CardSnapshotView {
  if (json === null || json === undefined || !json.trim()) return { status: "none" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "unreadable" };
  }
  // Parsed but not a card: a bare string, a number, an array, or an object
  // with no `modules` map. Something is stored and it is not readable.
  if (!isObject(parsed) || !isObject(parsed.modules)) return { status: "unreadable" };

  const kind = readKind(parsed.kind);
  const stored = parsed.modules as Record<string, unknown>;
  // Card order, not storage order: JSON key order is whatever the model
  // emitted, and the reader learned this card in the order it was drawn.
  // Custom modules are left out — their headings live in the card design
  // config, which a snapshot months old has no claim on.
  const modules = MODULE_DEFINITIONS[kind].flatMap((definition): CardSnapshotModule[] => {
    if (SKIPPED_SNAPSHOT_MODULES.includes(definition.id)) return [];
    const content = stored[definition.id];
    if (!hasModuleContent(content)) return [];
    return [{ id: definition.id, labelKey: definition.labelKey, content }];
  });

  if (modules.length === 0) return { status: "none" };
  const refreshedAt = readRefreshedAt(parsed.refreshedAt);
  // The key is left off entirely when there is no stamp, so a snapshot written
  // before regeneration existed is indistinguishable from one written after.
  return refreshedAt === undefined
    ? { status: "ready", kind, modules }
    : { status: "ready", kind, modules, refreshedAt };
}
