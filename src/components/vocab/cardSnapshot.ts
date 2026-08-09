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
 */
export function serializeCardSnapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!json) return null;
  if (new TextEncoder().encode(json).length > MAX_CARD_SNAPSHOT_BYTES) return null;
  return json;
}
