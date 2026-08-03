import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultProgressReadoutMode,
  nextProgressReadoutMode,
  parseProgressReadoutMode,
  PROGRESS_READOUT_MODES,
} from "../src/pages/reader/progress-readout.ts";

test("parseProgressReadoutMode defaults to page for undefined", () => {
  assert.equal(parseProgressReadoutMode(undefined), "page");
});

test("parseProgressReadoutMode defaults to page for garbage input", () => {
  assert.equal(parseProgressReadoutMode("nonsense"), "page");
});

test("parseProgressReadoutMode round-trips every known mode", () => {
  for (const mode of PROGRESS_READOUT_MODES) {
    assert.equal(parseProgressReadoutMode(mode), mode);
  }
});

test("defaultProgressReadoutMode starts hidden only when every progress toggle is off", () => {
  const off = { showChapterProgress: false, showBookProgress: false, showPageNumbers: false };
  assert.equal(defaultProgressReadoutMode(off), "hidden");
  assert.equal(defaultProgressReadoutMode({ ...off, showChapterProgress: true }), "page");
  assert.equal(defaultProgressReadoutMode({ ...off, showBookProgress: true }), "page");
  assert.equal(defaultProgressReadoutMode({ ...off, showPageNumbers: true }), "page");
});

test("nextProgressReadoutMode cycles page -> chapterTime -> bookTime -> hidden -> page", () => {
  assert.equal(nextProgressReadoutMode("page"), "chapterTime");
  assert.equal(nextProgressReadoutMode("chapterTime"), "bookTime");
  assert.equal(nextProgressReadoutMode("bookTime"), "hidden");
  assert.equal(nextProgressReadoutMode("hidden"), "page");
});
