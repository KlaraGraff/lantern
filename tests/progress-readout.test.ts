import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("nextProgressReadoutMode cycles page -> chapterTime -> bookTime -> hidden -> page", () => {
  assert.equal(nextProgressReadoutMode("page"), "chapterTime");
  assert.equal(nextProgressReadoutMode("chapterTime"), "bookTime");
  assert.equal(nextProgressReadoutMode("bookTime"), "hidden");
  assert.equal(nextProgressReadoutMode("hidden"), "page");
});
