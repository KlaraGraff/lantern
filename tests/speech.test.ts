import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SPEECH_SETTINGS,
  parseSpeechSettings,
  SPEECH_CUSTOM_SPEED_RANGE,
  SPEECH_RATE_PRESETS,
  SPEECH_RATE_RANGE,
} from "../src/components/speech/types.ts";
import {
  accentAvailability,
  englishVoices,
  fallbackVoice,
  speechSynthesisSupported,
  voiceForAccent,
} from "../src/components/speech/system-voices.ts";
import { audioMimeType } from "../src/components/speech/remote-audio.ts";

function voice(lang: string, name = lang, isDefault = false): SpeechSynthesisVoice {
  return { lang, name, default: isDefault, localService: true, voiceURI: name } as SpeechSynthesisVoice;
}

/** Replaces the voice inventory the way a given OS install would expose it. */
function withVoices<T>(voices: SpeechSynthesisVoice[] | null, run: () => T): T {
  const previous = Reflect.get(globalThis, "window");
  Reflect.set(
    globalThis,
    "window",
    voices === null ? {} : { speechSynthesis: { getVoices: () => voices } },
  );
  try {
    return run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previous);
  }
}

test("speech settings fall back to the documented defaults", () => {
  assert.deepEqual(parseSpeechSettings({}), DEFAULT_SPEECH_SETTINGS);
  assert.deepEqual(
    parseSpeechSettings({ speech_source: "nonsense", speech_accent: "au", speech_rate: "abc" }),
    DEFAULT_SPEECH_SETTINGS,
  );
});

test("speech settings round-trip valid values", () => {
  assert.deepEqual(
    parseSpeechSettings({ speech_source: "system", speech_accent: "uk", speech_rate: "1.2" }),
    { source: "system", accent: "uk", rate: 1.2, custom: DEFAULT_SPEECH_SETTINGS.custom },
  );
});

test("the custom source and its provider settings round-trip", () => {
  const parsed = parseSpeechSettings({
    speech_source: "custom",
    tts_base_url: "  https://api.openai.com/v1  ",
    tts_model: "gpt-4o-mini-tts",
    tts_voice_uk: "alloy",
    tts_voice_us: "nova",
    tts_speed: "1.25",
  });
  assert.equal(parsed.source, "custom");
  // Trimmed, or a stray space would end up in the request URL.
  assert.deepEqual(parsed.custom, {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    voiceUk: "alloy",
    voiceUs: "nova",
    speed: 1.25,
  });
});

test("provider settings default to empty rather than undefined", () => {
  assert.deepEqual(parseSpeechSettings({}).custom, {
    baseUrl: "",
    model: "",
    voiceUk: "",
    voiceUs: "",
    speed: 1,
  });
});

test("the custom TTS speed is clamped to what speech endpoints accept", () => {
  assert.equal(parseSpeechSettings({ tts_speed: "9" }).custom.speed, SPEECH_CUSTOM_SPEED_RANGE.max);
  assert.equal(parseSpeechSettings({ tts_speed: "0" }).custom.speed, SPEECH_CUSTOM_SPEED_RANGE.min);
  assert.equal(parseSpeechSettings({ tts_speed: "nonsense" }).custom.speed, 1);
});

test("speech rate is clamped to the supported range", () => {
  assert.equal(parseSpeechSettings({ speech_rate: "9" }).rate, SPEECH_RATE_RANGE.max);
  assert.equal(parseSpeechSettings({ speech_rate: "0.1" }).rate, SPEECH_RATE_RANGE.min);
});

// The slider had no step, so a 0.5–1.5 range collapsed to its two endpoints.
// Every preset must be reachable by stepping from the minimum.
test("every rate preset lands on a step of the slider", () => {
  for (const preset of SPEECH_RATE_PRESETS) {
    assert.ok(preset >= SPEECH_RATE_RANGE.min && preset <= SPEECH_RATE_RANGE.max, `${preset} in range`);
    const steps = (preset - SPEECH_RATE_RANGE.min) / SPEECH_RATE_RANGE.step;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${preset} on a step`);
  }
});

test("both accents are available when the system ships both voices", () => {
  withVoices([voice("en-GB"), voice("en-US")], () => {
    assert.deepEqual(accentAvailability(), { uk: true, us: true });
  });
});

// The common Windows install. The UI dims the missing accent and explains it
// rather than silently pretending the switch worked.
test("a US-only install reports British as unavailable", () => {
  withVoices([voice("en-US", "David"), voice("en-US", "Zira")], () => {
    assert.deepEqual(accentAvailability(), { uk: false, us: true });
    assert.equal(voiceForAccent("uk"), null);
    assert.equal(voiceForAccent("us")?.name, "David");
  });
});

// macOS interleaves novelty voices (Zarvox, Bubbles, Bad News) with real ones
// in an OS-determined order, so taking the first match is a coin flip.
test("the system default voice wins over list order", () => {
  withVoices([voice("en-US", "Bad News"), voice("en-US", "Samantha", true)], () => {
    assert.equal(voiceForAccent("us")?.name, "Samantha");
  });
});

test("a default voice in the other accent does not leak", () => {
  withVoices([voice("en-US", "Samantha", true), voice("en-GB", "Daniel")], () => {
    assert.equal(voiceForAccent("uk")?.name, "Daniel");
    assert.equal(voiceForAccent("us")?.name, "Samantha");
  });
});

test("a missing accent still falls back to some English voice", () => {
  withVoices([voice("en-US", "David")], () => {
    assert.equal(fallbackVoice()?.name, "David");
  });
});

test("underscore and mixed-case language tags are recognized", () => {
  withVoices([voice("en_gb", "Daniel")], () => {
    assert.deepEqual(accentAvailability(), { uk: true, us: false });
    assert.equal(voiceForAccent("uk")?.name, "Daniel");
  });
});

test("non-English voices are ignored", () => {
  withVoices([voice("zh-CN"), voice("fr-FR")], () => {
    assert.deepEqual(englishVoices(), []);
    assert.deepEqual(accentAvailability(), { uk: false, us: false });
    assert.equal(fallbackVoice(), null);
  });
});

test("a webview without speechSynthesis reports no support", () => {
  withVoices(null, () => {
    assert.equal(speechSynthesisSupported(), false);
    assert.deepEqual(accentAvailability(), { uk: false, us: false });
  });
});

// The endpoint labels WAV payloads `audio/mpeg`; trusting the header makes
// British audio fail to play while American audio works.
test("audio container is sniffed from the magic bytes, not the header", () => {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
  const mp3Id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  assert.equal(audioMimeType(wav), "audio/wav");
  assert.equal(audioMimeType(mp3Id3), "audio/mpeg");
  assert.equal(audioMimeType(mp3Frame), "audio/mpeg");
});
