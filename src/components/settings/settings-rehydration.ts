/**
 * Re-reading a settings pane's rows after something outside the pane changed
 * them.
 *
 * A pane copies the persisted `settings` map into local React state so its
 * controls can move before the write has landed. That copy goes stale the
 * moment another surface writes the same keys — the reader's 「设为全局默认」,
 * a second window, another pane — and a pane that copies only once keeps
 * showing the old value for as long as it stays mounted.
 *
 * Copying again on *every* change is the worse bug, not the fix: the copy is
 * also what the user is dragging, typing into and toggling right now, and a
 * pane's own write comes back to it as a settings change like any other. A
 * naive re-copy snaps the control back to the value the user just left.
 *
 * The rule here re-reads a group of keys only when both hold:
 *
 * - the stored value differs from what this pane last read *or wrote*. A pane
 *   records the values it writes at the moment it writes them, so its own echo
 *   arrives already explained and is never re-read.
 * - the pane has no write of its own outstanding for any key in the group.
 *   While a write is in flight the group is skipped whole, so a slow echo
 *   carrying an older value cannot overtake a newer local one.
 *
 * Groups, not keys, because a pane parses several keys into one piece of state
 * (four switches into one visibility object). Half a group is not a value.
 */

export interface RehydrationGroup {
  /** The pane's name for one block of state hydrated together. */
  id: string;
  /** The settings keys that block is built from. */
  keys: readonly string[];
}

export interface RehydrationInput {
  groups: readonly RehydrationGroup[];
  /** The settings map as it is stored now. */
  stored: Record<string, string | undefined>;
  /** What the pane last read out of that map, or wrote into it. */
  applied: Record<string, string | undefined>;
  /** Keys the pane is writing right now. */
  pending: Iterable<string>;
  /**
   * Groups the pane refuses to have replaced regardless — an editor holding
   * unsaved text is the case this exists for.
   */
  blocked?: Iterable<string>;
}

/** The ids of the groups that may safely be re-read from `stored`. */
export function groupsToRehydrate({
  groups,
  stored,
  applied,
  pending,
  blocked,
}: RehydrationInput): string[] {
  const pendingKeys = new Set(pending);
  const blockedIds = new Set(blocked ?? []);
  return groups
    .filter((group) => {
      if (blockedIds.has(group.id)) return false;
      if (group.keys.some((key) => pendingKeys.has(key))) return false;
      return group.keys.some((key) => stored[key] !== applied[key]);
    })
    .map((group) => group.id);
}

/** The keys of the named groups, flattened — what a pane snapshots after re-reading. */
export function rehydrationKeys(
  groups: readonly RehydrationGroup[],
  ids: readonly string[],
): string[] {
  const wanted = new Set(ids);
  return groups.filter((group) => wanted.has(group.id)).flatMap((group) => [...group.keys]);
}

/** The slice of the stored map a pane records once it has taken those keys. */
export function appliedSnapshot(
  keys: readonly string[],
  stored: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = stored[key];
  return snapshot;
}

/**
 * Counted, not a flag: two writes can be in flight over the same key, and the
 * first to settle must not declare the key quiet while the second is still out.
 */
export function addPendingWrites(pending: Map<string, number>, keys: Iterable<string>): void {
  for (const key of keys) pending.set(key, (pending.get(key) ?? 0) + 1);
}

export function removePendingWrites(pending: Map<string, number>, keys: Iterable<string>): void {
  for (const key of keys) {
    const remaining = (pending.get(key) ?? 0) - 1;
    if (remaining > 0) pending.set(key, remaining);
    else pending.delete(key);
  }
}
