import assert from "node:assert/strict";
import test from "node:test";

import {
  READING_IDLE_TIMEOUT_MS,
  ReadingSessionTracker,
  type ReadingSessionClock,
  type ReadingSessionInput,
} from "../src/pages/reading-stats/session-tracker.ts";

class FakeClock implements ReadingSessionClock {
  nowMs = 1_000_000;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.nowMs = target;
  }

  jumpWithoutTimers(ms: number): void {
    this.nowMs += ms;
  }
}

function fixture() {
  const clock = new FakeClock();
  const recorded: ReadingSessionInput[] = [];
  const tracker = new ReadingSessionTracker({
    clock,
    record: async (input) => { recorded.push(input); },
  });
  return { clock, recorded, tracker };
}

test("five idle minutes end at the last activity and are not counted", async () => {
  const { clock, recorded, tracker } = fixture();
  tracker.setBook("book-a");
  tracker.activity();
  clock.advance(60_000);
  tracker.activity();
  clock.advance(READING_IDLE_TIMEOUT_MS);
  await tracker.whenIdle();

  assert.equal(recorded.length, 2); // periodic checkpoint + final idempotent update
  assert.deepEqual(recorded.at(-1), {
    bookId: "book-a",
    startedAt: 1_000_000,
    endedAt: 1_060_000,
    activeSeconds: 60,
    checkpointKey: "book-a:1000000",
  });
});

test("blur and page hide close foreground segments while focus starts no synthetic time", async () => {
  const { clock, recorded, tracker } = fixture();
  tracker.setBook("book-a");
  tracker.activity();
  clock.advance(45_000);
  tracker.blur();
  clock.advance(90_000);
  tracker.focus();
  tracker.activity();
  clock.advance(35_000);
  tracker.pageHide();
  await tracker.whenIdle();

  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].activeSeconds, 45);
  assert.equal(recorded[1].activeSeconds, 35);
  assert.equal(recorded[1].startedAt - recorded[0].endedAt, 90_000);
});

test("book switches flush the old book without leaking time into the new one", async () => {
  const { clock, recorded, tracker } = fixture();
  tracker.setBook("book-a");
  tracker.activity();
  clock.advance(40_000);
  tracker.setBook("book-b");
  tracker.activity();
  clock.advance(31_000);
  await tracker.stop();

  assert.deepEqual(recorded.map(({ bookId, activeSeconds }) => ({ bookId, activeSeconds })), [
    { bookId: "book-a", activeSeconds: 40 },
    { bookId: "book-b", activeSeconds: 31 },
  ]);
});

test("a sleep-sized clock jump is ended by heartbeat without backfilling suspended time", async () => {
  const { clock, recorded, tracker } = fixture();
  tracker.setBook("book-a");
  tracker.activity();
  clock.advance(75_000);
  tracker.activity();
  clock.jumpWithoutTimers(2 * 60 * 60 * 1000);
  tracker.heartbeat();
  await tracker.whenIdle();

  assert.equal(recorded.length, 2); // periodic checkpoint + final idempotent update
  assert.equal(recorded.at(-1)?.activeSeconds, 75);
  assert.equal(recorded.at(-1)?.endedAt, 1_075_000);
});

test("short foreground segments are sent to the backend for the authoritative 30-second discard", async () => {
  const { clock, recorded, tracker } = fixture();
  tracker.setBook("book-a");
  tracker.activity();
  clock.advance(12_000);
  await tracker.stop();
  assert.equal(recorded[0].activeSeconds, 12);
});
