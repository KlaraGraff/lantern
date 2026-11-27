/**
 * The number rows in Settings → Reading are typed into one keystroke at a time,
 * so most of what is on screen mid-edit is not a valid value yet: "2" on the way
 * to "24" is below a 12px minimum, "" on the way to anything is not a number.
 * Those drafts stay on screen; only a draft that is already a valid value
 * reaches the pane's state.
 */
export function acceptedNumberDraft(raw: string, min?: number, max?: number): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (min !== undefined && value < min) return null;
  if (max !== undefined && value > max) return null;
  return value;
}
