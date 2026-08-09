/** `card_snapshot` is a nullable TEXT column; anything past this is refused
 * rather than stored, so one runaway model response cannot bloat every sync
 * payload carrying this row. Callers get `null` back, which the backend
 * already treats as "nothing to store" (never as "erase the existing one"). */
export const MAX_CARD_SNAPSHOT_BYTES = 64 * 1024;

/**
 * Serialises a learning card result for storage, or returns `null` if the
 * value is empty or the JSON would exceed the size guard.
 *
 * Pulled into its own module (no i18n/tauri imports) so it can be unit
 * tested with a plain `node --test` run, the same way `gloss.ts` is.
 *
 * @param refreshedAt when this card replaced an earlier one, in unix millis.
 *   Only the regenerate path passes it, and the panel reads it back to say
 *   "refreshed on" instead of "saved on" — the row's `created_at` is when the
 *   word was collected, which stops being the truth about the card the first
 *   time it is regenerated. Omitting it stores exactly the bytes a collect
 *   stored before this existed, so every card already in the database keeps
 *   reading as "saved on" with no migration.
 */
export function serializeCardSnapshot(value: unknown, refreshedAt?: number): string | null {
  if (value === null || value === undefined) return null;
  const stored = refreshedAt !== undefined
    && typeof value === "object"
    && !Array.isArray(value)
      ? { ...value, refreshedAt }
      : value;
  let json: string;
  try {
    json = JSON.stringify(stored);
  } catch {
    return null;
  }
  if (!json) return null;
  if (new TextEncoder().encode(json).length > MAX_CARD_SNAPSHOT_BYTES) return null;
  return json;
}
