import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_READER_BACKGROUND_OPACITY,
  parseReaderBackground,
  serializeReaderBackground,
} from "../src/components/reader-settings.ts";
import {
  createDefaultReaderSettings,
  resolveReaderSettings,
} from "../src/pages/reader/useReaderSettingsSync.ts";
import { buildReadingDefaultSettings } from "../src/components/settings/reading-defaults.ts";

test("an absent, empty or malformed row means no picture", () => {
  for (const value of [undefined, null, "", "not json", "{}", '{"path":""}', '{"path":3}', "42"]) {
    assert.equal(parseReaderBackground(value), null, String(value));
  }
});

test("a stored picture round-trips, with opacity clamped and defaulted", () => {
  const picture = { path: "/data/reader-backgrounds/abc.png", opacity: 40 };
  assert.deepEqual(parseReaderBackground(serializeReaderBackground(picture)), picture);
  assert.equal(serializeReaderBackground(null), "");
  assert.equal(parseReaderBackground('{"path":"/a.png","opacity":500}')?.opacity, 100);
  assert.equal(parseReaderBackground('{"path":"/a.png","opacity":-3}')?.opacity, 5);
  assert.equal(parseReaderBackground('{"path":"/a.png"}')?.opacity, DEFAULT_READER_BACKGROUND_OPACITY);
});

test("the reader picks the picture up from the global row and drops it when cleared", () => {
  const base = createDefaultReaderSettings();
  assert.equal(base.background, null);
  const withPicture = resolveReaderSettings(base, {
    reader_background: '{"path":"/a.png","opacity":25}',
  });
  assert.deepEqual(withPicture.background, { path: "/a.png", opacity: 25 });
  assert.equal(resolveReaderSettings(withPicture, { reader_background: "" }).background, null);
});

test("restore defaults turns the picture off", () => {
  assert.equal(buildReadingDefaultSettings(createDefaultReaderSettings()).reader_background, "");
});
