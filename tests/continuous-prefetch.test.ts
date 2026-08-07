import test from "node:test";
import assert from "node:assert/strict";
import { createSentencePrefetch } from "../src/components/speech/continuous-prefetch.ts";
import type { Playback, PlaybackStep } from "../src/components/speech/player.ts";

const settings = { source: "edge" } as const;
const other = { source: "system" } as const;

/** A plan whose steps record every request they are asked to make. */
function recorder(text: string, requests: string[], chunks = 1) {
  return () => Array.from({ length: chunks }, (_, chunk): PlaybackStep => async () => {
    requests.push(`${text}#${chunk}`);
    return { kind: "voice", text, voice: null, rate: 1 };
  });
}

async function firstPlayback(steps: PlaybackStep[]): Promise<Playback> {
  return steps[0]();
}

test("a warmed sentence is played from the fetch that was already in flight", async () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, recorder("s2", requests));
  assert.deepEqual(requests, ["s2#0"], "warming starts the request immediately");

  const steps = ahead.take({ id: "s2", settings }, recorder("s2", requests), 1);
  await firstPlayback(steps);
  assert.deepEqual(requests, ["s2#0"], "playing it must not ask a second time");
});

test("warming the same sentence twice does not buy it twice", () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, recorder("s2", requests));
  ahead.warm({ id: "s2", settings }, recorder("s2", requests));
  assert.deepEqual(requests, ["s2#0"]);
});

test("only one sentence is ever warm, so a run cannot accumulate paid-for audio", () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, recorder("s2", requests));
  ahead.warm({ id: "s3", settings }, recorder("s3", requests));
  ahead.warm({ id: "s4", settings }, recorder("s4", requests));
  assert.deepEqual(requests, ["s2#0", "s3#0", "s4#0"]);
  // The earlier two are gone: taking one of them plans afresh.
  const steps = ahead.take({ id: "s2", settings }, recorder("s2", requests), 1);
  assert.equal(steps.length, 1);
});

test("skipping past the warmed sentence keeps it warm for when playback arrives", async () => {
  // `skip` cancels the current audio before it knows where it is going. A
  // sentence already paid for must survive that and still be there on arrival.
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s3", settings }, recorder("s3", requests));

  const detour = ahead.take({ id: "s1", settings }, recorder("s1", requests), 1);
  await firstPlayback(detour);
  assert.deepEqual(requests, ["s3#0", "s1#0"]);

  const arrival = ahead.take({ id: "s3", settings }, recorder("s3", requests), 1);
  await firstPlayback(arrival);
  assert.deepEqual(requests, ["s3#0", "s1#0"], "the warmed clip answered, no new request");
});

test("changed speech settings invalidate the warmed clip", async () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, recorder("s2", requests));
  const steps = ahead.take({ id: "s2", settings: other }, recorder("s2", requests), 1);
  await firstPlayback(steps);
  assert.deepEqual(requests, ["s2#0", "s2#0"], "a clip planned for another voice is not reused");
});

test("a warmed fetch that failed is retried rather than skipping the sentence", async () => {
  let attempt = 0;
  const plan = () => [async (): Promise<Playback> => {
    attempt += 1;
    if (attempt === 1) throw new Error("SPEECH_SOURCE_UNAVAILABLE");
    return { kind: "voice", text: "s2", voice: null, rate: 1 };
  }];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, plan);
  const steps = ahead.take({ id: "s2", settings }, plan, 1);
  const playback = await firstPlayback(steps);
  assert.equal(playback.text, "s2");
  assert.equal(attempt, 2);
});

test("a warmed fetch nobody plays never surfaces as an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const ahead = createSentencePrefetch();
    ahead.warm({ id: "s2", settings }, () => [async () => {
      throw new Error("SPEECH_SOURCE_UNAVAILABLE");
    }]);
    // Playback went elsewhere and the warmed clip is simply dropped.
    ahead.warm({ id: "s9", settings }, () => [async (): Promise<Playback> =>
      ({ kind: "voice", text: "s9", voice: null, rate: 1 })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
});

test("the rate in force when the sentence is due wins over the one it was warmed at", async () => {
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, () => [async (): Promise<Playback> =>
    ({ kind: "voice", text: "s2", voice: null, rate: 1 })]);
  const steps = ahead.take({ id: "s2", settings }, recorder("s2", []), 1.5);
  assert.equal((await firstPlayback(steps)).rate, 1.5);
});

test("every chunk of a multi-chunk sentence carries the current rate", async () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, recorder("s2", requests, 3));
  const steps = ahead.take({ id: "s2", settings }, recorder("s2", requests, 3), 0.5);
  assert.equal(steps.length, 3);
  for (const step of steps) assert.equal((await step()).rate, 0.5);
  // Only the first chunk was warmed; the player fetches the rest as it goes.
  assert.deepEqual(requests, ["s2#0", "s2#1", "s2#2"]);
});

test("an empty plan warms nothing and still plans fresh when the sentence is due", async () => {
  const requests: string[] = [];
  const ahead = createSentencePrefetch();
  ahead.warm({ id: "s2", settings }, () => []);
  const steps = ahead.take({ id: "s2", settings }, recorder("s2", requests), 1);
  assert.equal(steps.length, 1);
  await firstPlayback(steps);
  assert.deepEqual(requests, ["s2#0"]);
});
