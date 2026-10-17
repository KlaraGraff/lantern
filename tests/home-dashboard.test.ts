import test from "node:test";
import assert from "node:assert/strict";
import {
  greetingFor,
  lastReadOf,
  lastSevenDays,
  latestChapterWords,
  localDateKey,
  minutesLeft,
  secondsPerDay,
  splitDuration,
} from "../src/pages/home/home-dashboard-model.ts";

test("greetingFor splits the day at 5, 12 and 18", () => {
  assert.equal(greetingFor(4), "evening");
  assert.equal(greetingFor(5), "morning");
  assert.equal(greetingFor(11), "morning");
  assert.equal(greetingFor(12), "afternoon");
  assert.equal(greetingFor(17), "afternoon");
  assert.equal(greetingFor(18), "evening");
  assert.equal(greetingFor(0), "evening");
});

test("lastSevenDays ends at tomorrow's midnight and lists today last", () => {
  const now = new Date(2026, 9, 17, 15, 30);
  const { start, end, days } = lastSevenDays(now);
  assert.equal(start, new Date(2026, 9, 11).getTime());
  assert.equal(end, new Date(2026, 9, 18).getTime());
  assert.deepEqual(days, ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
});

test("lastSevenDays crosses a month boundary", () => {
  const { days } = lastSevenDays(new Date(2026, 10, 3, 9));
  assert.deepEqual(days, ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("localDateKey pads month and day", () => {
  assert.equal(localDateKey(new Date(2026, 0, 5)), "2026-01-05");
});

test("secondsPerDay fills missing days with zero and keeps order", () => {
  const days = ["2026-10-15", "2026-10-16", "2026-10-17"];
  const calendar = [
    { date: "2026-10-17", activeSeconds: 600 },
    { date: "2026-10-15", activeSeconds: 120 },
    { date: "2026-09-01", activeSeconds: 999 },
  ];
  assert.deepEqual(secondsPerDay(calendar, days), [120, 0, 600]);
});

test("splitDuration rounds to whole minutes", () => {
  assert.deepEqual(splitDuration(0), { hours: 0, minutes: 0 });
  assert.deepEqual(splitDuration(29), { hours: 0, minutes: 0 });
  assert.deepEqual(splitDuration(90), { hours: 0, minutes: 2 });
  assert.deepEqual(splitDuration(3 * 3600 + 25 * 60), { hours: 3, minutes: 25 });
  assert.deepEqual(splitDuration(-5), { hours: 0, minutes: 0 });
});

test("minutesLeft needs both a length and a pace", () => {
  assert.equal(minutesLeft(null, 50, 200), null);
  assert.equal(minutesLeft(0, 50, 200), null);
  assert.equal(minutesLeft(10000, 50, null), null);
  assert.equal(minutesLeft(10000, 50, 0), null);
});

test("minutesLeft scales the remaining share by pace", () => {
  assert.equal(minutesLeft(20000, 50, 200), 50);
  assert.equal(minutesLeft(20000, 0, 200), 100);
  assert.equal(minutesLeft(20000, 100, 200), null);
  assert.equal(minutesLeft(20000, 99.99, 200), 1);
  assert.equal(minutesLeft(20000, 140, 200), null);
});

test("lastReadOf buckets by local calendar day", () => {
  const now = new Date(2026, 9, 17, 9);
  assert.deepEqual(lastReadOf(new Date(2026, 9, 17, 0, 5).getTime(), now), { kind: "today" });
  assert.deepEqual(lastReadOf(new Date(2026, 9, 16, 23, 50).getTime(), now), { kind: "yesterday" });
  assert.deepEqual(lastReadOf(new Date(2026, 9, 16, 0, 0).getTime(), now), { kind: "yesterday" });
  assert.deepEqual(lastReadOf(new Date(2026, 9, 15, 23).getTime(), now), { kind: "daysAgo", days: 2 });
  assert.deepEqual(lastReadOf(new Date(2026, 9, 10, 12).getTime(), now), { kind: "daysAgo", days: 7 });
});

const lookup = (lookup_text: string, chapter: string | null, last_looked_up_at: number) => ({ lookup_text, chapter, last_looked_up_at });

test("latestChapterWords picks the newest lookup's chapter", () => {
  const result = latestChapterWords([
    lookup("ephemeral", "Chapter 1", 1),
    lookup("languid", "Chapter 3", 5),
    lookup("verdant", "Chapter 3", 4),
    lookup("gossamer", "Chapter 2", 3),
  ]);
  assert.deepEqual(result, { chapter: "Chapter 3", words: ["languid", "verdant"], total: 2 });
});

test("latestChapterWords skips chapterless lookups and dedupes words case-insensitively", () => {
  const result = latestChapterWords([
    lookup("Gossamer", "  The Garden ", 10),
    lookup("stray", null, 20),
    lookup("gossamer", "The Garden", 8),
    lookup("  ", "The Garden", 7),
    lookup("verdant", "The Garden", 6),
  ]);
  assert.deepEqual(result, { chapter: "The Garden", words: ["Gossamer", "verdant"], total: 2 });
});

test("latestChapterWords caps the list but reports the full count", () => {
  const records = ["a", "b", "c", "d", "e", "f"].map((w, i) => lookup(w, "Ch", 100 - i));
  const result = latestChapterWords(records, 4);
  assert.deepEqual(result, { chapter: "Ch", words: ["a", "b", "c", "d"], total: 6 });
});

test("latestChapterWords returns null with no chapter anywhere", () => {
  assert.equal(latestChapterWords([]), null);
  assert.equal(latestChapterWords([lookup("x", null, 1), lookup("y", "  ", 2)]), null);
});
