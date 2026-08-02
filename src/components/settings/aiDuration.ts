/**
 * One vocabulary for "how long until this model works again", shared by the
 * status chip in settings and the toast that appears mid-read. The two would
 * otherwise round differently and quietly contradict each other.
 */

/**
 * Coarse on purpose. The exact second only carries information below a minute;
 * above that, rounding up keeps the number from ever promising too little.
 */
export function formatDuration(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return t("settings.ai.duration.seconds", { count: seconds });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("settings.ai.duration.minutes", { count: minutes });
  return t("settings.ai.duration.hours", { count: Math.ceil(minutes / 60) });
}
