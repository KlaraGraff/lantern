export function createSettingsSaveFeedback() {
  return { revision: 0, latest: new Map<string, number>(), failed: new Set<string>() };
}

/** Persistence success and permission to show a success toast are separate. */
export async function runSettingsSave(
  feedback: ReturnType<typeof createSettingsSaveFeedback>,
  keys: string[],
  write: () => Promise<unknown>,
  onFailure: () => void,
  onSuccess?: () => void,
): Promise<boolean> {
  const request = ++feedback.revision;
  for (const key of keys) feedback.latest.set(key, request);
  try {
    await write();
  } catch {
    const current = keys.filter((key) => feedback.latest.get(key) === request);
    for (const key of current) feedback.failed.add(key);
    if (current.length > 0) onFailure();
    return false;
  }
  const current = keys.filter((key) => feedback.latest.get(key) === request);
  for (const key of current) feedback.failed.delete(key);
  if (current.length === keys.length && feedback.failed.size === 0) onSuccess?.();
  return true;
}
