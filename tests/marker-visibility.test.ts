import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MARKER_VISIBILITY,
  MARKER_VISIBILITY_KEYS,
  MARKER_VISIBILITY_SETTING_KEY,
  WORD_MARKER_BY_MASTERY,
  markerVisibilitySummary,
  resolveMarkerVisibility,
  systemMark,
  wordMarkerColor,
  wordMarkerForMastery,
  wordMarkerStyle,
  type MarkerVisibility,
} from "../src/components/mark-palette.ts";

const ALL_ON: MarkerVisibility = {
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
};

const ALL_OFF: MarkerVisibility = {
  showLookupMarkers: false,
  showNewVocabMarkers: false,
  showLearningMarkers: false,
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

test("the mastered switch is gone, and its stale row cannot bring it back", () => {
  // Mastered words are never marked now, so there is nothing left to switch.
  // The `settings` row survives on any install that once turned it on; reading
  // it again would resurrect a switch with no mark behind it.
  assert.ok(!MARKER_VISIBILITY_KEYS.includes("showMasteredMarkers" as never));
  assert.deepEqual(
    resolveMarkerVisibility({ show_mastered_markers: "true" }),
    DEFAULT_MARKER_VISIBILITY,
  );
  assert.ok(!("showMasteredMarkers" in resolveMarkerVisibility({ show_mastered_markers: "true" })));
});

test("one row does not answer for the other two", () => {
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
    resolveMarkerVisibility({ show_lookup_markers: undefined, show_learning_markers: undefined }),
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
  // Three, not four: the total is read off `MARKER_VISIBILITY_KEYS` rather than
  // written down anywhere, and this is what pins that it still is.
  assert.deepEqual(markerVisibilitySummary(ALL_ON), { state: "all", shown: 3, total: 3 });
  assert.deepEqual(markerVisibilitySummary(ALL_OFF), { state: "none", shown: 0, total: 3 });
  assert.deepEqual(
    markerVisibilitySummary({ ...ALL_ON, showLearningMarkers: false }),
    { state: "partial", shown: 2, total: 3 },
  );
  assert.deepEqual(
    markerVisibilitySummary({ ...ALL_OFF, showLearningMarkers: true }),
    { state: "partial", shown: 1, total: 3 },
  );
});

test("one switch on or off is still partial, never all or none", () => {
  for (const key of MARKER_VISIBILITY_KEYS) {
    assert.equal(markerVisibilitySummary({ ...ALL_OFF, [key]: true }).state, "partial", key);
    assert.equal(markerVisibilitySummary({ ...ALL_ON, [key]: false }).state, "partial", key);
  }
});

test("the default state is what the settings page shows out of the box", () => {
  // Every remaining switch governs a word the reader is still working on, so
  // out of the box the heading reads "all shown" rather than a fraction.
  assert.deepEqual(
    markerVisibilitySummary(DEFAULT_MARKER_VISIBILITY),
    { state: "all", shown: 3, total: 3 },
  );
});

// The half this file exists for now: which mark a mastery tier actually wears.
// It was decided by elimination before — "not mastered and not learning" — so a
// `familiar` word was painted with the brand-new-word colour and hidden by the
// new-word switch, and no test noticed for as long as the tier existed.
test("each mastery tier draws the mark it is supposed to", () => {
  assert.deepEqual(wordMarkerForMastery("new"), {
    color: wordMarkerColor.vocabNew,
    visibility: "showNewVocabMarkers",
  });
  assert.deepEqual(wordMarkerForMastery("learning"), {
    color: wordMarkerColor.learning,
    visibility: "showLearningMarkers",
  });
  assert.deepEqual(wordMarkerForMastery("familiar"), {
    color: wordMarkerColor.familiar,
    visibility: "showLearningMarkers",
  });
  assert.equal(wordMarkerForMastery("mastered"), null);
});

test("familiar wears the dashed grey, and it is the same grey as before", () => {
  // The reassignment must not have moved a hex: this palette was tuned against
  // every paper theme, and a new colour would spend the headroom between the
  // two marks a reader sees most.
  const mark = wordMarkerStyle[wordMarkerColor.familiar];
  assert.equal(mark, systemMark.familiar);
  assert.equal(mark.color, "#94A3B8");
  assert.equal(mark.shape, "underline");
  assert.equal(mark.dashed, true);
  assert.equal(systemMark.vocabNew.color, "#D97706");
  assert.equal(systemMark.learning.color, "#2F9E8F");
});

test("a word with no tier recorded is a new word, not an unmarked one", () => {
  for (const missing of [null, undefined, ""]) {
    assert.deepEqual(
      wordMarkerForMastery(missing),
      WORD_MARKER_BY_MASTERY.new,
      `${JSON.stringify(missing)} should have resolved to the new-word mark`,
    );
  }
});

test("a tier the palette does not know draws nothing at all", () => {
  // The fall-through that caused the bug, closed from the other side: a fifth
  // tier added later lands on no mark rather than inheriting the new-word one.
  for (const unknown of ["retired", "suspended", "MASTERED"]) {
    assert.equal(wordMarkerForMastery(unknown), null, unknown);
  }
});

test("mastered has no sentinel to be drawn with", () => {
  // Not just "no mark today" — there is no colour value that could carry one
  // through foliate, so nothing can opt a mastered word back into being marked.
  assert.ok(!("mastered" in wordMarkerColor));
  assert.ok(!Object.values(wordMarkerColor).includes("__mastered__" as never));
  assert.deepEqual(
    Object.keys(wordMarkerStyle).sort(),
    [wordMarkerColor.familiar, wordMarkerColor.learning, wordMarkerColor.vocabNew].sort(),
  );
});

test("every tier a marked word can be in is gated by a switch that exists", () => {
  for (const [tier, mark] of Object.entries(WORD_MARKER_BY_MASTERY)) {
    if (!mark) continue;
    assert.ok(
      MARKER_VISIBILITY_KEYS.includes(mark.visibility),
      `${tier} is gated by ${mark.visibility}, which is not a switch`,
    );
    assert.ok(wordMarkerStyle[mark.color], `${tier}'s sentinel has no style behind it`);
  }
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

test("both sides read the same settings rows", () => {
  for (const key of MARKER_VISIBILITY_KEYS) {
    const row = MARKER_VISIBILITY_SETTING_KEY[key];
    assert.ok(
      readerSyncSource.includes(`globalSettings.${row}`),
      `the reader does not read the global row this page writes: ${row}`,
    );
  }
});
