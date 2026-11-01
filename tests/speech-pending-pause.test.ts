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
 * Nothing ends on its own — a test says when.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];

  currentTime = 0;
  readyState = 1;
  playing = false;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
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

// A pause that has not found a clip yet belongs to the request it was pressed
// for. Once that request is superseded there is nothing left for it to park, so
// it must not be handed to whichever playback starts next.
test("a pause left over from a superseded request does not swallow the next playback", async () => {
  const held = heldStep("passage-first");
  void speak("passage", async () => [held.step], { detached: true });
  await flush();
  assert.equal(playerState().status, "loading");

  pauseSpeech();
  assert.deepEqual(playerState().paused, { ownerId: "passage" });

  void speak("word", async () => [audioStep("hello")]);
  await flush();

  assert.equal(playerState().ownerId, "word");
  assert.equal(playerState().status, "playing", "the word must actually play");
  assert.deepEqual(playerState().paused, null, "the abandoned pause is not the word's to honour");
  assert.equal(FakeAudio.instances.length, 1, "the word's clip was played");
});

// The reading bar offers "resume" only while something is parked. A request
// that dies before its first clip leaves nothing to resume, so the claim has to
// go with the failure rather than outlive it.
test("a failed passage paused mid-load does not leave a phantom resume", async () => {
  const failingPlan = async (): Promise<PlaybackStep[]> => {
    throw new Error("SPEECH_SOURCE_UNAVAILABLE");
  };
  void speak("passage", failingPlan, { detached: true });
  pauseSpeech();
  await flush();

  assert.equal(playerState().status, "error");
  assert.deepEqual(playerState().paused, null, "nothing was ever fetched to resume");

  resumeSpeech();
  assert.notEqual(playerState().status, "loading", "resume must not restart a queue that never existed");
});
