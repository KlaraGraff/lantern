import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ContinuousReadAloudController,
  continuousReadReadout,
  defaultCharactersPerSecond,
  estimateRemainingSeconds,
  spokenFraction,
  supportsContinuousReadAloud,
  updatePace,
  type ContinuousReadSentence,
  type ContinuousReadState,
} from "../src/components/continuous-read-aloud.ts";

const sentences: ContinuousReadSentence[] = [
  { id: "s1", text: "First.", language: "en" },
  { id: "s2", text: "第二句。", language: "zh" },
  { id: "s3", text: "Third.", language: "en" },
];

function fixture() {
  const played: string[] = [];
  const revealed: string[] = [];
  const source = {
    first: async () => sentences[0],
    next: async (after: ContinuousReadSentence) => sentences[sentences.indexOf(after) + 1] ?? null,
    previous: async (before: ContinuousReadSentence) => sentences[sentences.indexOf(before) - 1] ?? null,
    reveal: async (sentence: ContinuousReadSentence) => { revealed.push(sentence.id); },
  };
  const player = { play: async (sentence: ContinuousReadSentence) => { played.push(sentence.id); }, pause() {}, resume() {}, stop() {} };
  return { controller: new ContinuousReadAloudController(source, player), played, revealed };
}

test("streams one sentence at a time across sections without preloading the book", async () => {
  const { controller, played, revealed } = fixture();
  await controller.start();
  assert.deepEqual(played, ["s1", "s2", "s3"]);
  assert.deepEqual(revealed, ["s1", "s2", "s3"]);
  assert.equal(controller.snapshot().status, "finished");
});

test("skip replaces a pending sentence and never lets its old completion advance", async () => {
  let finish!: () => void;
  const source = {
    first: async () => sentences[0],
    next: async (after: ContinuousReadSentence) => sentences[sentences.indexOf(after) + 1] ?? null,
    previous: async () => null,
    reveal: async () => {},
  };
  const played: string[] = [];
  const player = { play: async (sentence: ContinuousReadSentence) => { played.push(sentence.id); if (sentence.id === "s1") await new Promise<void>((resolve) => { finish = resolve; }); }, pause() {}, resume() {}, stop() {} };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const skip = controller.skip("next");
  finish();
  await skip;
  assert.deepEqual(played, ["s1", "s2", "s3"]);
  controller.stop();
  await run;
});

test("rate is clamped and applies without restarting the current sentence", () => {
  const { controller } = fixture();
  controller.setRate(9);
  assert.equal(controller.snapshot().rate, 2);
  controller.setRate(0);
  assert.equal(controller.snapshot().rate, 0.5);
});

test("pausing while a section loads does not start speech behind the paused UI", async () => {
  let reveal!: () => void;
  let revealCalls = 0;
  const played: string[] = [];
  const source = {
    first: async () => sentences[0],
    next: async () => null,
    previous: async () => null,
    reveal: async () => {
      revealCalls += 1;
      if (revealCalls > 1) return;
      await new Promise<void>((resolve) => { reveal = resolve; });
    },
  };
  const player = {
    play: async (sentence: ContinuousReadSentence) => { played.push(sentence.id); },
    pause() {},
    resume() {},
    stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.pause();
  reveal();
  await run;
  assert.equal(controller.snapshot().status, "paused");
  assert.deepEqual(played, []);

  controller.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(played, ["s1"]);
});

test("pausing before the first location resolves can resume the first sentence", async () => {
  let resolveFirst!: (sentence: ContinuousReadSentence) => void;
  const played: string[] = [];
  const source = {
    first: async () => new Promise<ContinuousReadSentence>((resolve) => { resolveFirst = resolve; }),
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: async (sentence: ContinuousReadSentence) => { played.push(sentence.id); },
    pause() {},
    resume() {},
    stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  controller.pause();
  resolveFirst(sentences[0]);
  await run;
  assert.equal(controller.snapshot().current?.id, "s1");
  assert.equal(controller.snapshot().status, "paused");
  controller.resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(played, ["s1"]);
});

test("continuous reading is offered only for reflowable EPUB", () => {
  assert.equal(supportsContinuousReadAloud("epub", true), true);
  assert.equal(supportsContinuousReadAloud("epub", false), false);
  assert.equal(supportsContinuousReadAloud("pdf", true), false);
  assert.equal(supportsContinuousReadAloud("text", true), false);
});

test("automatic reveals do not add entries to the reader return history", () => {
  const source = readFileSync(new URL("../src/pages/reader/foliate-continuous-source.ts", import.meta.url), "utf8");
  assert.match(source, /goTo\(sentence\.id, \{ history: false \}\)/u);
});

test("a foreground word mirrors the parked passage as paused and resumed", async () => {
  let finish!: () => void;
  const source = {
    first: async () => sentences[0],
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: async () => new Promise<void>((resolve) => { finish = resolve; }),
    pause() {},
    resume() {},
    stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.syncPlayerPaused();
  assert.equal(controller.snapshot().status, "paused");
  controller.syncPlayerPlaying();
  assert.equal(controller.snapshot().status, "playing");
  finish();
  await run;
});

test("a replacing detached passage abandons controls without cancelling its playback", async () => {
  let finish!: () => void;
  let stops = 0;
  const source = {
    first: async () => sentences[0],
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: async () => new Promise<void>((resolve) => { finish = resolve; }),
    pause() {},
    resume() {},
    stop() { stops += 1; },
  };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stops, 1);
  controller.abandon();
  assert.equal(controller.snapshot().status, "idle");
  assert.equal(stops, 1);
  finish();
  await run;
});

test("terminal states expand safely and restart from the first linear section", async () => {
  const starts: boolean[] = [];
  const source = {
    first: async (fromBeginning = false) => { starts.push(fromBeginning); return sentences[0]; },
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = { play: async () => {}, pause() {}, resume() {}, stop() {} };
  const controller = new ContinuousReadAloudController(source, player);
  controller.setCollapsed(true);
  await controller.start();
  assert.equal(controller.snapshot().status, "finished");
  assert.equal(controller.snapshot().collapsed, false);
  await controller.start(true);
  assert.deepEqual(starts, [false, true]);
});

test("setCollapsed(true) is ignored while finished", async () => {
  const { controller } = fixture();
  await controller.start();
  assert.equal(controller.snapshot().status, "finished");
  controller.setCollapsed(true);
  assert.equal(controller.snapshot().collapsed, false);
});

test("setCollapsed(true) is ignored while errored", async () => {
  const source = {
    first: async () => { throw new Error("boom"); },
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = { play: async () => {}, pause() {}, resume() {}, stop() {} };
  const controller = new ContinuousReadAloudController(source, player);
  await controller.start();
  assert.equal(controller.snapshot().status, "error");
  controller.setCollapsed(true);
  assert.equal(controller.snapshot().collapsed, false);
});

test("setCollapsed(true) still collapses during an active playing/paused state", async () => {
  let finish!: () => void;
  const source = {
    first: async () => sentences[0],
    next: async () => new Promise<ContinuousReadSentence | null>((resolve) => { finish = () => resolve(null); }),
    previous: async () => null,
    reveal: async () => {},
  };
  const player = { play: async () => {}, pause() {}, resume() {}, stop() {} };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.snapshot().status, "playing");
  controller.setCollapsed(true);
  assert.equal(controller.snapshot().collapsed, true);
  finish();
  await run;
});

// ---------------------------------------------------------------------------
// Chapter position and the time estimate
// ---------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A latin sentence long enough that its length is the interesting number. */
const LATIN = "x".repeat(120);

function stateWith(overrides: Partial<ContinuousReadState> = {}): ContinuousReadState {
  return {
    status: "playing",
    current: { id: "s", text: LATIN },
    rate: 1,
    collapsed: false,
    progress: null,
    pace: null,
    ...overrides,
  };
}

function at(index: number, total: number, remainingCharacters: number, text = LATIN): ContinuousReadSentence {
  return { id: `s${index}`, text, position: { index, total, remainingCharacters } };
}

test("the first sentence of a chapter reports its place and what is left of it", () => {
  // 900 characters at a measured 15/s is 60 seconds of speech at rate 1.
  const readout = continuousReadReadout(stateWith({ current: at(1, 9, 900), pace: 15, progress: 0 }));
  assert.deepEqual(readout.position, { index: 1, total: 9 });
  assert.equal(readout.fraction, 0);
  assert.equal(readout.lastSentence, false);
  assert.equal(readout.remainingMinutes, 1);
});

test("the last sentence of a chapter drops the estimate rather than counting down to zero", () => {
  const readout = continuousReadReadout(stateWith({ current: at(9, 9, 120), pace: 15 }));
  assert.deepEqual(readout.position, { index: 9, total: 9 });
  assert.equal(readout.lastSentence, true);
  assert.equal(readout.remainingMinutes, null);
  assert.equal(readout.fraction, 8 / 9);
});

test("a one-sentence chapter is both the first and the last sentence", () => {
  const readout = continuousReadReadout(stateWith({ current: at(1, 1, 120), pace: 15 }));
  assert.deepEqual(readout.position, { index: 1, total: 1 });
  assert.equal(readout.lastSentence, true);
  assert.equal(readout.fraction, 0);
  assert.equal(readout.remainingMinutes, null);
});

test("a source that cannot place a sentence produces no position at all", () => {
  const readout = continuousReadReadout(stateWith({ current: { id: "s", text: LATIN }, pace: 15 }));
  assert.equal(readout.position, null);
  assert.equal(readout.fraction, null);
  assert.equal(readout.remainingMinutes, null);
});

test("an empty or impossible chapter is never rendered as 0 / 0 or 5 / 3", () => {
  for (const position of [
    { index: 0, total: 0, remainingCharacters: 0 },
    { index: 5, total: 3, remainingCharacters: 100 },
    { index: 0, total: 9, remainingCharacters: 100 },
    { index: 1.5, total: 9, remainingCharacters: 100 },
  ]) {
    const readout = continuousReadReadout(stateWith({ current: { id: "s", text: LATIN, position } }));
    assert.equal(readout.position, null, `rendered ${position.index} / ${position.total}`);
    assert.equal(readout.remainingMinutes, null);
  }
});

test("the bar is indeterminate before the first sentence and full at the end of the book", () => {
  assert.deepEqual(continuousReadReadout(stateWith({ status: "loading", current: null })), {
    fraction: null,
    position: null,
    remainingMinutes: null,
    lastSentence: false,
  });
  assert.equal(continuousReadReadout(stateWith({ status: "finished", current: null })).fraction, 1);
});

test("a failed sentence keeps its position but stops claiming a time", () => {
  const readout = continuousReadReadout(stateWith({ status: "error", current: at(3, 9, 700), pace: 15 }));
  assert.deepEqual(readout.position, { index: 3, total: 9 });
  assert.equal(readout.remainingMinutes, null);
});

test("part of the current sentence already spoken counts against what is left", () => {
  const whole = continuousReadReadout(stateWith({ current: at(1, 2, 240), pace: 2, progress: 0 }));
  const half = continuousReadReadout(stateWith({ current: at(1, 2, 240), pace: 2, progress: 0.5 }));
  // 240 characters at 2/s is 120s; spending half of a 120-character sentence
  // removes 60 of them, so 90s remain.
  assert.equal(whole.remainingMinutes, 2);
  assert.equal(half.remainingMinutes, 2);
  assert.ok(half.fraction! > whole.fraction!);
  assert.equal(estimateRemainingSeconds(240 - 60, 2, LATIN, 1), 90);
});

test("the estimate scales with the speech rate rather than a fixed per-sentence constant", () => {
  const minutesAt = (rate: number) =>
    continuousReadReadout(stateWith({ current: at(1, 9, 1800), pace: 15, progress: 0, rate })).remainingMinutes;
  assert.equal(minutesAt(1), 2);
  assert.equal(minutesAt(2), 1);
  assert.equal(minutesAt(0.5), 4);
  assert.equal(estimateRemainingSeconds(1800, 15, LATIN, 1), 120);
  assert.equal(estimateRemainingSeconds(1800, 15, LATIN, 1.5), 80);
});

test("with no measurement yet the seed pace follows the script, not one global constant", () => {
  assert.equal(defaultCharactersPerSecond("Language is built from patterns."), 15);
  assert.equal(defaultCharactersPerSecond("语言由模式构成，而最令人满意的模式往往最简单。"), 5.5);
  // A latin sentence carrying a couple of borrowed characters is still latin.
  assert.equal(defaultCharactersPerSecond(`${LATIN}汉字`), 15);
  const latin = estimateRemainingSeconds(600, null, "Language is built from patterns.", 1);
  const cjk = estimateRemainingSeconds(600, null, "语言由模式构成。", 1);
  assert.ok(cjk! > latin!, "a CJK chapter of the same length must be estimated as longer");
});

test("an estimate is withheld rather than guessed when its inputs cannot support one", () => {
  assert.equal(estimateRemainingSeconds(0, 15, LATIN, 1), null);
  assert.equal(estimateRemainingSeconds(-40, 15, LATIN, 1), null);
  assert.equal(estimateRemainingSeconds(600, 15, LATIN, 0), null);
  assert.equal(estimateRemainingSeconds(Number.NaN, 15, LATIN, 1), null);
  // A nonsense measurement falls back to the seed instead of dividing by it.
  assert.equal(estimateRemainingSeconds(600, 0, LATIN, 1), 40);
});

test("pace is normalised to rate 1 so changing speed rescales the estimate", () => {
  // 300 characters in 10s at rate 2 is 15 characters per second at rate 1.
  assert.equal(updatePace(null, 300, 10_000, 2), 15);
  assert.equal(updatePace(null, 150, 10_000, 1), 15);
});

test("implausible samples leave the measured pace exactly where it was", () => {
  assert.equal(updatePace(12, 4, 5_000, 1), 12, "a four-character sentence times latency, not speech");
  assert.equal(updatePace(12, 300, 100, 1), 12, "no audio plays 300 characters in 100ms");
  assert.equal(updatePace(12, 300, 200_000, 1), 12, "a sentence cannot honestly take three minutes");
  assert.equal(updatePace(12, 300, 10_000, 0), 12);
  assert.equal(updatePace(null, 4, 5_000, 1), null);
});

test("a new sample moves the measured pace without letting one sentence own it", () => {
  const moved = updatePace(10, 300, 10_000, 1)!;
  assert.ok(moved > 10 && moved < 30, `expected a smoothed value, got ${moved}`);
  assert.equal(Math.round(moved * 100) / 100, 16);
});

// ---------------------------------------------------------------------------
// Within-sentence progress
// ---------------------------------------------------------------------------

const TIMINGS = [
  { text: "The", offsetMs: 0, durationMs: 200 },
  { text: "voice", offsetMs: 200, durationMs: 300 },
  { text: "carries", offsetMs: 500, durationMs: 400 },
  { text: "on", offsetMs: 900, durationMs: 200 },
];
const SPOKEN = "The voice carries on";

test("without word timings there is no honest split, so none is reported", () => {
  assert.equal(spokenFraction(SPOKEN, SPOKEN, 500, null), null);
  assert.equal(spokenFraction(SPOKEN, SPOKEN, 500, []), null);
  assert.equal(spokenFraction("", "", 500, TIMINGS), null);
});

test("progress within a sentence follows the words the voice has reached", () => {
  assert.equal(spokenFraction(SPOKEN, SPOKEN, -1, TIMINGS), 0);
  assert.equal(spokenFraction(SPOKEN, SPOKEN, 0, TIMINGS), 3 / SPOKEN.length);
  assert.equal(spokenFraction(SPOKEN, SPOKEN, 550, TIMINGS), "The voice carries".length / SPOKEN.length);
  assert.equal(spokenFraction(SPOKEN, SPOKEN, 99_999, TIMINGS), 1);
});

test("a sentence spoken in chunks reports progress over the whole sentence", () => {
  const sentence = `Before it: ${SPOKEN}, and after.`;
  const fraction = spokenFraction(sentence, SPOKEN, 550, TIMINGS)!;
  const expected = ("Before it: " + "The voice carries").length / sentence.length;
  assert.equal(fraction, expected);
  assert.ok(fraction < 1);
});

test("a chunk that cannot be located in the sentence still degrades to a fraction of it", () => {
  const fraction = spokenFraction(`${SPOKEN} and more`, "unrelated chunk", 550, TIMINGS)!;
  assert.equal(fraction, "The voice carries".length / `${SPOKEN} and more`.length);
});

// ---------------------------------------------------------------------------
// The controller's own half of the contract
// ---------------------------------------------------------------------------

test("the position the source reports travels into the state the bar reads", async () => {
  const placed = [at(1, 2, 240), at(2, 2, 120)];
  const seen: (number | undefined)[] = [];
  const source = {
    first: async () => placed[0],
    next: async (after: ContinuousReadSentence) => placed[placed.indexOf(after) + 1] ?? null,
    previous: async () => null,
    reveal: async () => {},
  };
  const controller = new ContinuousReadAloudController(source, {
    play: async () => {},
    pause() {},
    resume() {},
    stop() {},
  });
  controller.subscribe((state) => {
    if (state.status === "playing") seen.push(state.current?.position?.index);
  });
  await controller.start();
  assert.deepEqual(seen, [1, 2]);
});

test("within-sentence progress is quantised, and never carried into the next sentence", async () => {
  let finish!: () => void;
  const source = {
    first: async () => sentences[0],
    next: async (after: ContinuousReadSentence) => (after.id === "s1" ? sentences[1] : null),
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: async (sentence: ContinuousReadSentence) => {
      if (sentence.id === "s1") await new Promise<void>((resolve) => { finish = resolve; });
    },
    pause() {}, resume() {}, stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player);
  const run = controller.start();
  await tick();

  controller.reportProgress(0.5);
  assert.equal(controller.snapshot().progress, 0.5);
  // A report inside the same twelfth must not repaint the page underline.
  let publishes = 0;
  const stop = controller.subscribe(() => { publishes += 1; });
  controller.reportProgress(0.51);
  assert.equal(publishes, 0);
  assert.equal(controller.snapshot().progress, 0.5);
  stop();

  controller.reportProgress(null);
  assert.equal(controller.snapshot().progress, null);
  controller.reportProgress(0.9);

  finish();
  await run;
  assert.equal(controller.snapshot().progress, null);
});

test("the speaking pace is measured from sentences that ran start to finish", async () => {
  let clock = 0;
  const text = "y".repeat(150);
  const source = {
    first: async () => ({ id: "a", text }),
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: async () => { clock += 10_000; },
    pause() {}, resume() {}, stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player, () => clock);
  await controller.start();
  assert.equal(controller.snapshot().pace, 15);
});

test("a sentence the listener paused through is timed but not counted", async () => {
  let clock = 0;
  let finish!: () => void;
  const text = "y".repeat(150);
  const source = {
    first: async () => ({ id: "a", text }),
    next: async () => null,
    previous: async () => null,
    reveal: async () => {},
  };
  const player = {
    play: () => new Promise<void>((resolve) => { finish = resolve; }),
    pause() {}, resume() {}, stop() {},
  };
  const controller = new ContinuousReadAloudController(source, player, () => clock);
  const run = controller.start();
  await tick();
  controller.pause();
  controller.resume();
  clock += 600_000;
  finish();
  await run;
  assert.equal(controller.snapshot().pace, null, "a ten-minute pause is not a ten-minute sentence");
});
