import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWord,
  ScreenExposureTracker,
  tokenizeVisibleText,
  type FinalizedScreen,
  type ScreenExposureClock,
} from "../src/pages/reader/reading-behavior.ts";

class FakeClock implements ScreenExposureClock {
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
}

// ScreenExposureTracker's flush queue is a chain of real Promises (see
// flushNow() in reading-behavior.ts), so pushing into `flushed` happens on a
// microtask even after a synchronous forceFlush()/settle(). A macrotask tick
// reliably drains that chain regardless of how many .then hops are queued.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fixture(overrides: { settleDelayMs?: number; flushDelayMs?: number } = {}) {
  const clock = new FakeClock();
  const flushed: FinalizedScreen[][] = [];
  const tracker = new ScreenExposureTracker({
    clock,
    flush: async (screens) => { flushed.push(screens); },
    settleDelayMs: overrides.settleDelayMs,
    flushDelayMs: overrides.flushDelayMs,
  });
  return { clock, flushed, tracker };
}

test("normalizeWord mirrors the Rust normalize(): trims non-alnum/apostrophe edges and lowercases", () => {
  assert.equal(normalizeWord("Lantern,"), "lantern");
  assert.equal(normalizeWord("“Quiet”"), "quiet");
  assert.equal(normalizeWord("'twas"), "'twas");
  assert.equal(normalizeWord("don't"), "don't");
  assert.equal(normalizeWord("--dusk--"), "dusk");
});

test("tokenizeVisibleText dedupes content words, drops stopwords and pure numbers", () => {
  const { rawTokenCount, contentWords } = tokenizeVisibleText(
    "The quiet lantern lit the 42 dusky room. The lantern glowed."
  );
  // Raw count includes every token, stopwords and repeats included — the
  // §5.1 pace numerator.
  assert.equal(rawTokenCount, 11);
  assert.deepEqual([...contentWords].sort(), ["dusky", "glowed", "lantern", "lit", "quiet", "room"]);
});

test("a settled screen is finalized and flushed once a later relocate defines the next screen boundary", async () => {
  const { clock, flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Chapter 1", cfi: "cfi-1", visibleText: "quiet lantern dusk" });
  clock.advance(500); // past the 400ms settle debounce: screen A becomes current
  assert.equal(flushed.length, 0, "a screen isn't finalized until a boundary closes it");
  tracker.noteRelocate({ chapter: "Chapter 1", cfi: "cfi-2", visibleText: "next screen text" });
  clock.advance(500); // settling screen B finalizes screen A
  clock.advance(2000); // past the 1500ms flush debounce
  await flushMicrotasks();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 1);
  assert.deepEqual([...flushed[0][0].words].sort(), ["dusk", "lantern", "quiet"]);
  assert.equal(flushed[0][0].bookId, "book-1");
  assert.equal(flushed[0][0].chapter, "Chapter 1");
  assert.equal(flushed[0][0].cfi, "cfi-1");
});

test("a burst of relocate events during one scroll gesture settles into a single screen", async () => {
  const { clock, flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "one two three" });
  clock.advance(100);
  tracker.noteRelocate({ chapter: "Ch1", cfi: "b", visibleText: "two three four" });
  clock.advance(100);
  tracker.noteRelocate({ chapter: "Ch1", cfi: "c", visibleText: "three four five" });
  clock.advance(500); // settle debounce elapses only after the burst stops
  tracker.forceFlush(); // close out and flush the one screen the burst produced
  await flushMicrotasks();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 1, "one scroll burst is one screen, not three");
  assert.deepEqual([...flushed[0][0].words].sort(), ["five", "four", "three"]);
});

test("operations recorded while a screen is active are counted on that screen", async () => {
  const { clock, flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern dusk" });
  clock.advance(500);
  tracker.recordOperation("selection");
  tracker.recordOperation("lookup", "dusk");
  tracker.recordOperation("bookmark");
  // A second screen ends the first and finalizes it.
  tracker.noteRelocate({ chapter: "Ch1", cfi: "b", visibleText: "next page words here" });
  clock.advance(500);
  clock.advance(2000);
  await flushMicrotasks();

  const first = flushed.flat().find((s) => s.cfi === "a")!;
  assert.equal(first.operationCount, 3);
  assert.equal(first.lookupCount, 1);
  assert.deepEqual(first.lookedUpWords, ["dusk"]);
});

test("operations on a screen never leak into the next screen", async () => {
  const { clock, flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern" });
  clock.advance(500);
  tracker.recordOperation("lookup", "lantern");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "b", visibleText: "dusk falls" });
  clock.advance(500); // settling screen b finalizes screen a
  tracker.forceFlush(); // close out and flush screen b too, so we can inspect it
  await flushMicrotasks();

  const screens = flushed.flat();
  const first = screens.find((s) => s.cfi === "a")!;
  const second = screens.find((s) => s.cfi === "b")!;
  assert.equal(first.operationCount, 1);
  assert.equal(first.lookupCount, 1);
  assert.equal(second.operationCount, 0, "a fresh screen starts with no operations");
  assert.equal(second.lookupCount, 0);
});

test("forceFlush settles a pending position and flushes immediately, bypassing both debounces", async () => {
  const { flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern" });
  // No clock.advance() at all — forceFlush must not depend on the debounce firing.
  tracker.forceFlush();
  await flushMicrotasks();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0][0].cfi, "a");
});

test("a book switch flushes the outgoing book without leaking words into the new one", async () => {
  const { clock, flushed, tracker } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern" });
  clock.advance(500);
  tracker.setBook("book-2");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "x", visibleText: "different words entirely" });
  clock.advance(500);
  tracker.forceFlush(); // close out and flush book-2's screen too
  await flushMicrotasks();

  const byBook = new Map(flushed.flat().map((s) => [s.bookId, s]));
  assert.equal(byBook.get("book-1")?.cfi, "a");
  assert.equal(byBook.get("book-2")?.cfi, "x");
});

test("stop() flushes the current screen and resolves once the write settles", async () => {
  const { tracker, flushed } = fixture();
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern" });
  await tracker.stop();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0][0].cfi, "a");
});

test("a failing flush is swallowed and never blocks a later batch", async () => {
  const clock = new FakeClock();
  const flushed: FinalizedScreen[][] = [];
  let calls = 0;
  const tracker = new ScreenExposureTracker({
    clock,
    flush: async (screens) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated write failure");
      flushed.push(screens);
    },
  });
  tracker.setBook("book-1");
  tracker.noteRelocate({ chapter: "Ch1", cfi: "a", visibleText: "quiet lantern" });
  tracker.forceFlush(); // fails, swallowed

  tracker.setBook("book-1"); // no-op, same book
  tracker.noteRelocate({ chapter: "Ch1", cfi: "b", visibleText: "second screen" });
  tracker.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 2);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0][0].cfi, "b");
});
