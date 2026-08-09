import assert from "node:assert/strict";
import test from "node:test";
import {
  SKIPPED_SNAPSHOT_MODULES,
  buildCardSnapshotView,
  hasModuleContent,
} from "../src/components/vocab/cardSnapshotView.ts";

// The bug this exists for: the whole learning card has been stored on collect
// since migration 067, and no surface ever read it back. Turning that blob
// into "which blocks, in what order, and how many" is the part that decides
// whether the panel says anything at all — so it is the part that gets tested
// away from React, i18n and Tauri.

const ready = (json: string | null | undefined) => {
  const view = buildCardSnapshotView(json);
  assert.equal(view.status, "ready", `expected a readable card, got ${view.status}`);
  return view as Extract<typeof view, { status: "ready" }>;
};

test("no snapshot at all is not an error — the section simply has nothing to say", () => {
  assert.deepEqual(buildCardSnapshotView(null), { status: "none" });
  assert.deepEqual(buildCardSnapshotView(undefined), { status: "none" });
});

test("an empty or blank column reads as no snapshot, not as damage", () => {
  assert.deepEqual(buildCardSnapshotView(""), { status: "none" });
  assert.deepEqual(buildCardSnapshotView("   \n "), { status: "none" });
});

test("a blob that will not parse is damage, and says so", () => {
  assert.deepEqual(buildCardSnapshotView("{not json"), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("{\"modules\":"), { status: "unreadable" });
});

test("valid JSON that is not a card is damage too", () => {
  // Something is stored in the row. Staying silent here would tell the reader
  // their card was never saved, which is the one wrong thing to say.
  assert.deepEqual(buildCardSnapshotView("\"just a string\""), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("42"), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("null"), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("[]"), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("{\"kind\":\"word\"}"), { status: "unreadable" });
  assert.deepEqual(buildCardSnapshotView("{\"modules\":[]}"), { status: "unreadable" });
});

test("a well-formed card with no modules shows nothing — it is not damage", () => {
  assert.deepEqual(
    buildCardSnapshotView(JSON.stringify({ version: 1, kind: "word", modules: {} })),
    { status: "none" },
  );
});

test("the two modules the panel already prints are never redrawn", () => {
  // `context_meaning` is the contextual definition and `source_excerpt` is the
  // saved sentence; both sit above this section already.
  const json = JSON.stringify({
    kind: "word",
    modules: {
      context_meaning: { summary: "brittle: about her tone, not about glass" },
      source_excerpt: { quote: "Her answer came back brittle." },
    },
  });
  assert.deepEqual(buildCardSnapshotView(json), { status: "none" });
  assert.deepEqual([...SKIPPED_SNAPSHOT_MODULES], ["context_meaning", "source_excerpt"]);
});

test("modules present but empty do not count towards the block count", () => {
  const json = JSON.stringify({
    kind: "word",
    modules: {
      word_info: {},
      collocations: { meta: [], details: [], items: [] },
      usage: { summary: "   " },
      memory_aid: { summary: "break + little" },
    },
  });
  const view = ready(json);
  assert.deepEqual(view.modules.map((module) => module.id), ["memory_aid"]);
});

test("blocks come back in card order, not in the order the model emitted them", () => {
  const json = JSON.stringify({
    kind: "word",
    modules: {
      memory_aid: { summary: "break + little" },
      context_meaning: { summary: "already shown above" },
      collocations: { details: ["brittle laugh", "brittle bones"] },
      word_info: { heading: "brittle · adjective" },
      source_excerpt: { quote: "already shown above" },
      synonyms: { items: [{ title: "fragile" }] },
    },
  });
  const view = ready(json);
  assert.equal(view.kind, "word");
  // MODULE_DEFINITIONS.word order: word_info, collocations, synonyms, memory_aid.
  assert.deepEqual(
    view.modules.map((module) => module.id),
    ["word_info", "collocations", "synonyms", "memory_aid"],
  );
  assert.equal(view.modules.length, 4);
});

test("each block carries the heading key the settings screen already names it by", () => {
  const json = JSON.stringify({ kind: "word", modules: { memory_aid: { summary: "x" } } });
  assert.deepEqual(ready(json).modules[0].labelKey, "settings.tools.modules.memory_aid");
});

test("a phrase card is ordered by the phrase card's own module list", () => {
  // A collected phrase stores `kind: "phrase"`, whose modules include ones the
  // word card has no slot for. Reading it as a word card would drop them.
  const json = JSON.stringify({
    kind: "phrase",
    modules: {
      idioms: { details: ["hold one's tongue"] },
      target_translation: { summary: "忍住不说" },
      grammar_analysis: { summary: "verb + possessive + noun" },
    },
  });
  const view = ready(json);
  assert.equal(view.kind, "phrase");
  assert.deepEqual(
    view.modules.map((module) => module.id),
    ["target_translation", "grammar_analysis", "idioms"],
  );
});

test("an unknown or missing kind is read as a word card", () => {
  const modules = { memory_aid: { summary: "break + little" } };
  assert.equal(ready(JSON.stringify({ modules })).kind, "word");
  assert.equal(ready(JSON.stringify({ kind: "sonnet", modules })).kind, "word");
});

test("custom modules are left out — a months-old snapshot has no heading for them", () => {
  const json = JSON.stringify({
    kind: "word",
    modules: {
      custom_etymology: { summary: "from Old English brēotan" },
      usage: { summary: "almost always negative about a person" },
    },
  });
  assert.deepEqual(ready(json).modules.map((module) => module.id), ["usage"]);
});

test("hasModuleContent accepts any one populated field and rejects the rest", () => {
  assert.equal(hasModuleContent({ heading: "brittle" }), true);
  assert.equal(hasModuleContent({ summary: "x" }), true);
  assert.equal(hasModuleContent({ quote: "x" }), true);
  assert.equal(hasModuleContent({ meta: ["adjective"] }), true);
  assert.equal(hasModuleContent({ details: ["x"] }), true);
  assert.equal(hasModuleContent({ items: [{ title: "x" }] }), true);
  assert.equal(hasModuleContent({}), false);
  assert.equal(hasModuleContent({ heading: "  " }), false);
  assert.equal(hasModuleContent(null), false);
  assert.equal(hasModuleContent("summary"), false);
  assert.equal(hasModuleContent([{ summary: "x" }]), false);
});
