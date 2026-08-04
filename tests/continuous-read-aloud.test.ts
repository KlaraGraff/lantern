import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ContinuousReadAloudController,
  supportsContinuousReadAloud,
  type ContinuousReadSentence,
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
