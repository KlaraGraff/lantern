/**
 * The library home's pure half: greeting, the 7-day window, durations, the
 * "continue reading" estimates and the chapter-words digest. No React, no
 * Tauri — `tests/home-dashboard.test.ts` drives it directly.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type Greeting = "morning" | "afternoon" | "evening";

/** 05–11 morning, 12–17 afternoon, everything else evening (a late reader is still "evening"). */
export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/**
 * The last seven local days, today included: [start of the day six days ago,
 * start of tomorrow). Rolling rather than calendar-week, so a Monday morning
 * does not open on an empty strip.
 */
export function lastSevenDays(now: Date): { start: number; end: number; days: string[] } {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() - 6);
  const end = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() + 1);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return localDateKey(day);
  });
  return { start: start.getTime(), end: end.getTime(), days };
}

/** `YYYY-MM-DD` in local time — the key the reading-stats calendar uses. */
export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Seconds read on each of `days`, in order; days with no entry read zero. */
export function secondsPerDay(calendar: ReadonlyArray<{ date: string; activeSeconds: number }>, days: readonly string[]): number[] {
  const byDay = new Map(calendar.map((entry) => [entry.date, entry.activeSeconds]));
  return days.map((day) => byDay.get(day) ?? 0);
}

/** Whole hours and the remaining whole minutes. */
export function splitDuration(seconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/**
 * Minutes left in a book at the reader's pace, or null when either number is
 * missing. `progress` is the books table's 0–100.
 */
export function minutesLeft(totalTokens: number | null | undefined, progress: number, wordsPerMinute: number | null | undefined): number | null {
  if (!totalTokens || !wordsPerMinute || wordsPerMinute <= 0) return null;
  const remaining = totalTokens * (1 - Math.min(Math.max(progress, 0), 100) / 100);
  if (remaining <= 0) return null;
  return Math.max(1, Math.round(remaining / wordsPerMinute));
}

/** How long ago, coarsely: the same day, the day before, or a count of days. */
export type LastRead = { kind: "today" } | { kind: "yesterday" } | { kind: "daysAgo"; days: number };

export function lastReadOf(at: number, now: Date): LastRead {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= startOfToday) return { kind: "today" };
  if (at >= startOfToday - DAY_MS) return { kind: "yesterday" };
  return { kind: "daysAgo", days: Math.max(2, Math.ceil((startOfToday - at) / DAY_MS)) };
}

export interface LookupLike {
  lookup_text: string;
  chapter: string | null;
  last_looked_up_at: number;
}

/**
 * The chapter the reader last looked something up in, and the words from it,
 * most recent first. The library keeps no "current chapter" for a book; the
 * newest lookup's chapter is the closest stored fact (and it is never ahead of
 * the reader — no spoiler can come from it).
 */
export function latestChapterWords(records: readonly LookupLike[], limit = 4): { chapter: string; words: string[]; total: number } | null {
  const sorted = [...records].sort((a, b) => b.last_looked_up_at - a.last_looked_up_at);
  const chapter = sorted.find((record) => record.chapter?.trim())?.chapter?.trim();
  if (!chapter) return null;
  const seen = new Set<string>();
  const words: string[] = [];
  for (const record of sorted) {
    if (record.chapter?.trim() !== chapter) continue;
    const word = record.lookup_text.trim();
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return { chapter, words: words.slice(0, limit), total: words.length };
}
