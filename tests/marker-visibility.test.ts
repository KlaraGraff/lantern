import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MARKER_VISIBILITY,
  MARKER_VISIBILITY_KEYS,
  MARKER_VISIBILITY_SETTING_KEY,
  markerVisibilitySummary,
  resolveMarkerVisibility,
  type MarkerVisibility,
} from "../src/components/mark-palette.ts";

const ALL_ON: MarkerVisibility = {
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
  showMasteredMarkers: true,
};

const ALL_OFF: MarkerVisibility = {
  showLookupMarkers: false,
  showNewVocabMarkers: false,
  showLearningMarkers: false,
  showMasteredMarkers: false,
};

const rows = (visibility: MarkerVisibility): Record<string, string> => Object.fromEntries(
  MARKER_VISIBILITY_KEYS.map((key) => [MARKER_VISIBILITY_SETTING_KEY[key], String(visibility[key])]),
);

test("no rows at all means the hardcoded defaults, unchanged", () => {
  // The state every install that predates the global layer upgrades into. If
  // this ever stops holding, a reader who never opened this page finds their
  // book differently marked than they left it.
  assert.deepEqual(resolveMarkerVisibility({}), DEFAULT_MARKER_VISIBILITY);
});

test("a row that is there is obeyed, either way", () => {
  assert.deepEqual(resolveMarkerVisibility(rows(ALL_ON)), ALL_ON);
  assert.deepEqual(resolveMarkerVisibility(rows(ALL_OFF)), ALL_OFF);
});

test("mastered is off by default and stays off unless a row says otherwise", () => {
  // The one default that is not `true`, and the one most likely to be lost in a
  // rewrite that assumes "absent means show it".
  assert.equal(DEFAULT_MARKER_VISIBILITY.showMasteredMarkers, false);
  assert.equal(resolveMarkerVisibility({ show_learning_markers: "false" }).showMasteredMarkers, false);
  assert.equal(resolveMarkerVisibility({ show_mastered_markers: "true" }).showMasteredMarkers, true);
});

test("one row does not answer for the other three", () => {
  assert.deepEqual(resolveMarkerVisibility({ show_lookup_markers: "false" }), {
    ...DEFAULT_MARKER_VISIBILITY,
    showLookupMarkers: false,
  });
});

test("junk falls back to the default rather than to off", () => {
  // A truncated write or a hand-edited database must not read as "hide it".
  // Anything but the two strings the app writes is no answer at all.
  for (const junk of ["", " ", "1", "0", "TRUE", "False", "yes", "null", "undefined"]) {
    const settings = Object.fromEntries(
      MARKER_VISIBILITY_KEYS.map((key) => [MARKER_VISIBILITY_SETTING_KEY[key], junk]),
    );
    assert.deepEqual(
      resolveMarkerVisibility(settings),
      DEFAULT_MARKER_VISIBILITY,
      `"${junk}" should not have been read as an answer`,
    );
  }
});

test("an explicitly undefined row reads the same as a missing one", () => {
  assert.deepEqual(
    resolveMarkerVisibility({ show_lookup_markers: undefined, show_mastered_markers: undefined }),
    DEFAULT_MARKER_VISIBILITY,
  );
});

test("unrelated settings are ignored", () => {
  assert.deepEqual(
    resolveMarkerVisibility({ font_size: "26", show_page_numbers: "true", reader_theme: "paper" }),
    DEFAULT_MARKER_VISIBILITY,
  );
});

test("the summary names the state the heading is picked from", () => {
  assert.deepEqual(markerVisibilitySummary(ALL_ON), { state: "all", shown: 4, total: 4 });
  assert.deepEqual(markerVisibilitySummary(ALL_OFF), { state: "none", shown: 0, total: 4 });
  assert.deepEqual(
    markerVisibilitySummary({ ...ALL_ON, showMasteredMarkers: false }),
    { state: "partial", shown: 3, total: 4 },
  );
  assert.deepEqual(
    markerVisibilitySummary({ ...ALL_OFF, showLearningMarkers: true }),
    { state: "partial", shown: 1, total: 4 },
  );
});

test("one switch on or off is still partial, never all or none", () => {
  for (const key of MARKER_VISIBILITY_KEYS) {
    assert.equal(markerVisibilitySummary({ ...ALL_OFF, [key]: true }).state, "partial", key);
    assert.equal(markerVisibilitySummary({ ...ALL_ON, [key]: false }).state, "partial", key);
  }
});

test("the default state is what the settings page shows out of the box", () => {
  assert.deepEqual(
    markerVisibilitySummary(DEFAULT_MARKER_VISIBILITY),
    { state: "partial", shown: 3, total: 4 },
  );
});

// The reader keeps its own copy of these defaults — `createDefaultReaderSettings`
// spreads them into the reader state, and that module cannot be imported here
// because it reads `document` on the way in. So the copy is compared as text.
// Two answers to "what does a missing row mean" that disagree is the exact bug
// this whole layer exists to prevent.
const readerSyncSource = readFileSync(
  path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/pages/reader/useReaderSettingsSync.ts"),
  "utf8",
);

test("the reader's copy of the defaults still agrees with the palette's", () => {
  const block = readerSyncSource.match(/const DEFAULT_MARKER_VISIBILITY = \{([^}]*)\}/);
  assert.ok(block, "useReaderSettingsSync no longer declares DEFAULT_MARKER_VISIBILITY as an object literal");
  const declared = Object.fromEntries(
    [...block[1].matchAll(/(\w+)\s*:\s*(true|false)/g)].map(([, key, value]) => [key, value === "true"]),
  );
  assert.deepEqual(declared, { ...DEFAULT_MARKER_VISIBILITY });
});

test("both sides read the same four settings rows", () => {
  for (const key of MARKER_VISIBILITY_KEYS) {
    const row = MARKER_VISIBILITY_SETTING_KEY[key];
    assert.ok(
      readerSyncSource.includes(`globalSettings.${row}`),
      `the reader does not read the global row this page writes: ${row}`,
    );
  }
});
