import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  inBookPreviewSentence,
  resolveInBookPreviewPlan,
} from "../src/components/vocab/in-book-preview.ts";
import type { PassiveVocabSettings } from "../src/components/passive-vocab.ts";

const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(path.join(i18nDir, "zh.json"), "utf8")) as Record<string, string>;

function assertTranslated(key: string) {
  assert.ok(key in en, `missing from en.json: ${key}`);
  assert.ok(key in zh, `missing from zh.json: ${key}`);
}

function settings(overrides: Partial<PassiveVocabSettings> = {}): PassiveVocabSettings {
  return { enabled: true, style: "ruby", limit: 3, ...overrides };
}

test("i18n: the two user-facing strings exist in both locales", () => {
  assertTranslated("vocab.inBookPreview.label");
  assertTranslated("vocab.inBookPreview.annotationsOff");
});

test("inBookPreviewSentence: splits the real saved sentence around the word", () => {
  const result = inBookPreviewSentence("His countenance betrayed nothing.", "countenance");
  assert.deepEqual(result, { before: "His ", answer: "countenance", after: " betrayed nothing." });
});

test("inBookPreviewSentence: falls back to the bare word when there is no saved context", () => {
  assert.deepEqual(inBookPreviewSentence(null, "countenance"), { before: "", answer: "countenance", after: "" });
  assert.deepEqual(inBookPreviewSentence(undefined, "countenance"), { before: "", answer: "countenance", after: "" });
  assert.deepEqual(inBookPreviewSentence("   ", "countenance"), { before: "", answer: "countenance", after: "" });
});

test("inBookPreviewSentence: falls back when the saved sentence no longer contains the word", () => {
  assert.deepEqual(
    inBookPreviewSentence("A completely unrelated sentence.", "countenance"),
    { before: "", answer: "countenance", after: "" },
  );
});

test("resolveInBookPreviewPlan: annotations off always wins, regardless of mastery", () => {
  for (const mastery of ["new", "learning", "familiar", "mastered", null, undefined]) {
    assert.deepEqual(
      resolveInBookPreviewPlan(settings({ enabled: false }), mastery, "gloss", "sentence", "word", "epubcfi(/6/2!/4/2)"),
      { kind: "off" },
    );
  }
});

test("resolveInBookPreviewPlan: new/learning (and no tier at all) resolve to the definition stage", () => {
  for (const mastery of ["new", "learning", null, undefined]) {
    const plan = resolveInBookPreviewPlan(settings(), mastery, "face; expression", "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
    assert.equal(plan.kind, "definition");
  }
});

test("resolveInBookPreviewPlan: definition stage carries the reader's own style and the truncated label", () => {
  // Wider than passiveVocabLabel's 32-column ceiling, so the preview shows the
  // same clamped label the real in-book annotation would.
  const longDefinition = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rubyPlan = resolveInBookPreviewPlan(settings({ style: "ruby" }), "new", longDefinition, "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
  assert.equal(rubyPlan.kind, "definition");
  if (rubyPlan.kind === "definition") {
    assert.equal(rubyPlan.style, "ruby");
    assert.equal(rubyPlan.label, "abcdefghijklmnopqrstuvwxyz01234…");
    assert.deepEqual(rubyPlan.sentence, { before: "His ", answer: "countenance", after: " betrayed nothing." });
  }

  const marginPlan = resolveInBookPreviewPlan(settings({ style: "margin" }), "learning", "face; expression", "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
  assert.equal(marginPlan.kind, "definition");
  if (marginPlan.kind === "definition") {
    assert.equal(marginPlan.style, "margin");
    assert.equal(marginPlan.label, "face; expression"); // 16 columns — well under the cap, unchanged
  }
});

test("resolveInBookPreviewPlan: familiar resolves to the marker stage", () => {
  const plan = resolveInBookPreviewPlan(settings(), "familiar", "face; expression", "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
  assert.equal(plan.kind, "marker");
  if (plan.kind === "marker") {
    assert.deepEqual(plan.sentence, { before: "His ", answer: "countenance", after: " betrayed nothing." });
  }
});

test("resolveInBookPreviewPlan: mastered resolves to the none stage — no decoration at all", () => {
  const plan = resolveInBookPreviewPlan(settings(), "mastered", "face; expression", "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
  assert.equal(plan.kind, "none");
  if (plan.kind === "none") {
    assert.deepEqual(plan.sentence, { before: "His ", answer: "countenance", after: " betrayed nothing." });
  }
});

test("resolveInBookPreviewPlan: marker and none stages still fall back to the bare word without context", () => {
  const marker = resolveInBookPreviewPlan(settings(), "familiar", "gloss", null, "word", "epubcfi(/6/2!/4/2)");
  assert.equal(marker.kind, "marker");
  if (marker.kind === "marker") assert.deepEqual(marker.sentence, { before: "", answer: "word", after: "" });

  const none = resolveInBookPreviewPlan(settings(), "mastered", "gloss", null, "word", "epubcfi(/6/2!/4/2)");
  assert.equal(none.kind, "none");
  if (none.kind === "none") assert.deepEqual(none.sentence, { before: "", answer: "word", after: "" });
});

// selectPassiveVocab (passive-vocab.ts) skips any word with no CFI or an
// empty passiveVocabLabel before it ever reaches the definition stage — the
// real page draws nothing for such a word. The preview must agree, or it
// promises a definition the text never shows.
test("resolveInBookPreviewPlan: a definition-stage word with no CFI falls to none, not definition", () => {
  for (const cfi of [null, undefined, ""]) {
    const plan = resolveInBookPreviewPlan(settings(), "new", "face; expression", "His countenance betrayed nothing.", "countenance", cfi);
    assert.equal(plan.kind, "none");
    if (plan.kind === "none") {
      assert.deepEqual(plan.sentence, { before: "His ", answer: "countenance", after: " betrayed nothing." });
    }
  }
});

test("resolveInBookPreviewPlan: a definition-stage word whose label is empty falls to none, not definition", () => {
  for (const definition of [null, undefined, "", "   "]) {
    const plan = resolveInBookPreviewPlan(settings(), "new", definition, "His countenance betrayed nothing.", "countenance", "epubcfi(/6/2!/4/2)");
    assert.equal(plan.kind, "none");
  }
});

test("resolveInBookPreviewPlan: missing CFI does not affect the marker or none stages — those never gloss anything anyway", () => {
  const marker = resolveInBookPreviewPlan(settings(), "familiar", "face; expression", "His countenance betrayed nothing.", "countenance", null);
  assert.equal(marker.kind, "marker");

  const none = resolveInBookPreviewPlan(settings(), "mastered", "face; expression", "His countenance betrayed nothing.", "countenance", null);
  assert.equal(none.kind, "none");
});
