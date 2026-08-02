import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  cancelSpeech,
  pauseSpeech,
  playerState,
  resumeSpeech,
  speak,
  type Playback,
  type PlaybackStep,
} from "../src/components/speech/player.ts";

/**
 * The audio element the player builds for a clip, reduced to what it touches.
 * Nothing ends on its own — a test says when, which is what makes the parked
 * cases reproducible.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];

  currentTime = 0;
  readyState = 1;
  playing = false;
  seeks: number[] = [];
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  // Declared rather than a constructor parameter property, which Node's type
  // stripping cannot parse.
  readonly src: string;

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play() {
    this.playing = true;
    return Promise.resolve();
  }

  pause() {
    this.playing = false;
  }

  removeAttribute() {}
  load() {}
  addEventListener() {}

  /** Moves playback along, the way `timeupdate` would. */
  advanceTo(seconds: number) {
    this.currentTime = seconds;
    this.ontimeupdate?.();
  }

  end() {
    this.onended?.();
  }
}

/** The most recent element, which is the one making sound. */
function currentAudio(): FakeAudio {
  const audio = FakeAudio.instances[FakeAudio.instances.length - 1];
  assert.ok(audio, "expected the player to have built an audio element");
  return audio;
}

function audioStep(text: string): PlaybackStep {
  return async () => ({ kind: "audio", text, blob: new Blob([text]) } satisfies Playback);
}

/** A step whose clip only arrives when the test releases it. */
function heldStep(text: string) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step: PlaybackStep = async () => {
    await gate;
    return { kind: "audio", text, blob: new Blob([text]) } satisfies Playback;
  };
  return { step, release: () => release?.() };
}

/** Lets every already-resolved promise in the queue settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let originalUrl: { create: unknown; revoke: unknown };

beforeEach(() => {
  FakeAudio.instances = [];
  Reflect.set(globalThis, "Audio", FakeAudio);
  originalUrl = {
    create: Reflect.get(URL, "createObjectURL"),
    revoke: Reflect.get(URL, "revokeObjectURL"),
  };
  Reflect.set(URL, "createObjectURL", () => "blob:test");
  Reflect.set(URL, "revokeObjectURL", () => {});
});

afterEach(() => {
  cancelSpeech();
  Reflect.deleteProperty(globalThis, "Audio");
  Reflect.set(URL, "createObjectURL", originalUrl.create);
  Reflect.set(URL, "revokeObjectURL", originalUrl.revoke);
});

/**
 * Starts a passage and waits until it is actually making sound. The promise
 * `speak` returns only settles when the whole queue does, so it is deliberately
 * dropped — awaiting it would wait for audio no test ever ends.
 */
async function startPassage(ownerId = "passage", steps = [audioStep("first"), audioStep("second")]) {
  void speak(ownerId, async () => steps, { detached: true });
  await flush();
  assert.equal(playerState().status, "playing");
}

test("a word played over a passage parks it instead of ending it", async () => {
  await startPassage();
  const passageAudio = currentAudio();
  passageAudio.advanceTo(12);

  void speak("word", async () => [audioStep("hello")]);
  await flush();

  assert.equal(passageAudio.playing, false, "the passage should have stopped making sound");
  assert.deepEqual(playerState().paused, { ownerId: "passage" });
  assert.equal(playerState().ownerId, "word", "the word owns the foreground while it plays");
  assert.equal(playerState().status, "playing");
});

test("resuming a parked passage carries on from where it stopped", async () => {
  await startPassage();
  currentAudio().advanceTo(12);

  void speak("word", async () => [audioStep("hello")]);
  await flush();
  currentAudio().end();
  await flush();

  resumeSpeech();
  await flush();

  const resumed = currentAudio();
  assert.equal(playerState().ownerId, "passage");
  assert.equal(playerState().status, "playing");
  assert.equal(playerState().paused, null);
  assert.equal(resumed.playing, true);
  assert.equal(resumed.currentTime, 12, "playback should resume at the parked position");
});

test("a paused passage keeps its remaining steps", async () => {
  await startPassage();
  pauseSpeech();
  await flush();
  assert.equal(playerState().status, "paused");

  resumeSpeech();
  await flush();
  currentAudio().end();
  await flush();

  assert.equal(playerState().status, "playing", "the second step should follow the first");
  assert.equal(playerState().ownerId, "passage");
});

test("a pause that beats the first clip parks it rather than dropping the request", async () => {
  const held = heldStep("first");
  void speak("passage", async () => [held.step], { detached: true });
  await flush();
  assert.equal(playerState().status, "loading");

  pauseSpeech();
  assert.deepEqual(playerState().paused, { ownerId: "passage" });

  held.release();
  await flush();
  assert.equal(playerState().status, "paused");
  assert.equal(FakeAudio.instances.length, 0, "nothing should have played while paused");

  resumeSpeech();
  await flush();
  assert.equal(playerState().status, "playing");
  assert.equal(currentAudio().playing, true);
});

test("resuming before the first clip has arrived goes back to waiting", async () => {
  const held = heldStep("first");
  void speak("passage", async () => [held.step], { detached: true });
  await flush();

  pauseSpeech();
  resumeSpeech();
  assert.equal(playerState().status, "loading");
  assert.equal(playerState().paused, null);

  held.release();
  await flush();
  assert.equal(playerState().status, "playing");
});

test("stopping clears a parked passage so nothing lingers behind the bar", async () => {
  await startPassage();
  pauseSpeech();
  assert.equal(playerState().paused?.ownerId, "passage");

  cancelSpeech();
  assert.deepEqual(playerState(), {
    status: "idle",
    ownerId: null,
    detached: false,
    paused: null,
  });
});

test("a new passage replaces a parked one instead of queueing behind it", async () => {
  await startPassage("first-passage");
  pauseSpeech();
  assert.equal(playerState().paused?.ownerId, "first-passage");

  await startPassage("second-passage", [audioStep("other")]);
  assert.equal(playerState().paused, null);
  assert.equal(playerState().ownerId, "second-passage");
});

test("a second word leaves the parked passage alone", async () => {
  await startPassage();
  void speak("word", async () => [audioStep("hello")]);
  await flush();
  assert.equal(playerState().paused?.ownerId, "passage");

  void speak("another-word", async () => [audioStep("again")]);
  await flush();

  assert.equal(playerState().paused?.ownerId, "passage", "the passage is still waiting to resume");
  assert.equal(playerState().ownerId, "another-word");
});

test("a word that fails to play leaves the parked passage waiting", async () => {
  await startPassage();
  currentAudio().advanceTo(12);

  void speak("word", async () => [
    async () => {
      throw new Error("no clip for this one");
    },
  ]);
  await flush();
  assert.equal(playerState().status, "error");
  assert.deepEqual(playerState().paused, { ownerId: "passage" }, "the reading is still resumable");

  resumeSpeech();
  await flush();
  assert.equal(playerState().ownerId, "passage");
  assert.equal(playerState().status, "playing");
  assert.equal(currentAudio().currentTime, 12);
});

test("a word played while the passage is still loading wins outright", async () => {
  const held = heldStep("first");
  void speak("passage", async () => [held.step], { detached: true });
  await flush();
  assert.equal(playerState().status, "loading");

  void speak("word", async () => [audioStep("hello")]);
  await flush();

  assert.equal(playerState().paused, null, "there was no position worth keeping");
  assert.equal(playerState().ownerId, "word");
  held.release();
});
