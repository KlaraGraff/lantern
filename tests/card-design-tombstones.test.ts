import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_DEFINITIONS,
  createDefaultCardDesignConfig,
  parseCardDesignConfig,
  removeCardModule,
  removeMenuAction,
  restoreDefaultCardModules,
  restoreDefaultMenuActions,
  serializeCardDesignConfig,
} from "../src/components/learning-card/config.ts";
import type {
  CardDesignConfigV1,
  CustomLearningId,
} from "../src/components/learning-card/types.ts";

// serializeCardDesignConfig is JSON.stringify(parseCardDesignConfig(...)), so
// every save runs the config through the parser once more. A tombstone the
// parser forgets to carry out is erased by the very next save, and the symptom —
// "the thing I deleted came back a while later" — is close to untraceable.
function roundTrip(config: CardDesignConfigV1): CardDesignConfigV1 {
  return parseCardDesignConfig(serializeCardDesignConfig(config));
}

const moduleIds = (config: CardDesignConfigV1, kind: "word" | "phrase" | "passage") =>
  config.cards[kind].modules.map((module) => module.id);

test("a deleted built-in module stays deleted across a save round trip", () => {
  const config = createDefaultCardDesignConfig();
  config.cards.word = removeCardModule(config.cards.word, "common_senses");

  assert.ok(!moduleIds(config, "word").includes("common_senses"));
  assert.deepEqual(config.cards.word.removedModules, ["common_senses"]);

  const reloaded = roundTrip(config);
  assert.ok(
    !moduleIds(reloaded, "word").includes("common_senses"),
    "the fill-in-missing-built-ins loop put a deleted module back",
  );
  assert.deepEqual(reloaded.cards.word.removedModules, ["common_senses"]);
});

// S3 and S4 look identical in storage — the id is simply absent from the array.
// The tombstone is the only thing telling them apart, and both must hold at once.
test("a tombstoned built-in stays gone while a merely missing one returns", () => {
  const parsed = parseCardDesignConfig({
    version: 2,
    cards: {
      word: {
        modules: [{ id: "context_meaning", enabled: true }],
        removedModules: ["common_senses"],
      },
    },
    selectionMenus: {},
  });

  const ids = moduleIds(parsed, "word");
  assert.ok(!ids.includes("common_senses"), "deleted module reappeared");
  assert.ok(ids.includes("collocations"), "a built-in nobody deleted must still arrive");
});

test("no stored config at all yields the full factory defaults", () => {
  assert.deepEqual(parseCardDesignConfig(undefined), createDefaultCardDesignConfig());
  assert.deepEqual(parseCardDesignConfig("not json"), createDefaultCardDesignConfig());
});

test("a card emptied of every module round trips as empty", () => {
  let config = createDefaultCardDesignConfig();
  for (const { id } of MODULE_DEFINITIONS.word) {
    config = { ...config, cards: { ...config.cards, word: removeCardModule(config.cards.word, id) } };
  }
  assert.deepEqual(config.cards.word.modules, []);

  const reloaded = roundTrip(config);
  assert.deepEqual(reloaded.cards.word.modules, [], "an emptied card was refilled");
  assert.equal(reloaded.cards.word.removedModules?.length, MODULE_DEFINITIONS.word.length);
  // The other kinds are untouched: tombstones are stored per kind.
  assert.deepEqual(moduleIds(reloaded, "phrase"), moduleIds(createDefaultCardDesignConfig(), "phrase"));
});

test("restoring card modules rebuilds the built-ins and keeps what the user wrote", () => {
  const customId = "custom_abc123" as CustomLearningId;
  const factory = createDefaultCardDesignConfig();
  let card = factory.cards.word;
  card = {
    ...card,
    // A reordered, disabled, re-densified, half-deleted list with a custom module.
    modules: [
      { id: customId, enabled: true, defaultExpanded: false, density: "detailed" },
      ...card.modules.slice().reverse().map((module) => ({ ...module, enabled: false, density: "compact" as const })),
    ],
    customModules: {
      [customId]: { name: "Mine", prompt: "Explain it my way", createdAt: 1, updatedAt: 1 },
    },
  };
  card = removeCardModule(card, "collocations");

  const restored = restoreDefaultCardModules("word", card);
  const builtIns = restored.modules.filter((module) => !module.id.startsWith("custom_"));

  assert.deepEqual(builtIns, factory.cards.word.modules);
  assert.deepEqual(restored.removedModules, []);
  assert.deepEqual(
    restored.modules.filter((module) => module.id.startsWith("custom_")),
    [{ id: customId, enabled: true, defaultExpanded: false, density: "detailed" }],
    "a custom module is not a default and must survive the restore",
  );
  assert.deepEqual(restored.customModules, card.customModules);
  // Rows that are not list entries are none of this button's business.
  assert.equal(restored.defaultDensity, card.defaultDensity);
  assert.equal(restored.exampleCount, card.exampleCount);
});

test("junk in a tombstone is filtered out rather than stored", () => {
  const parsed = parseCardDesignConfig({
    version: 2,
    cards: {
      word: {
        modules: [],
        removedModules: [
          "made_up_module",
          "custom_deadbeef",
          "key_terms", // real id, but a passage module — not a word one
          "common_senses",
          "common_senses",
          42,
          null,
          ...Array.from({ length: 500 }, (_, index) => `filler_${index}`),
        ],
      },
    },
    selectionMenus: {},
  });

  assert.deepEqual(parsed.cards.word.removedModules, ["common_senses"]);
});

test("a deleted built-in menu action stays deleted across a save round trip", () => {
  const config = createDefaultCardDesignConfig();
  const { items, removed } = removeMenuAction(
    config.selectionMenus.word,
    config.removedMenuActions?.word ?? [],
    "copy",
  );
  config.selectionMenus.word = items;
  config.removedMenuActions = { ...config.removedMenuActions!, word: removed };

  const reloaded = roundTrip(config);
  assert.ok(!reloaded.selectionMenus.word.some((item) => item.id === "copy"));
  assert.deepEqual(reloaded.removedMenuActions?.word, ["copy"]);
  // Same action in another kind's menu is a different entry entirely.
  assert.ok(reloaded.selectionMenus.phrase.some((item) => item.id === "copy"));
  assert.deepEqual(reloaded.removedMenuActions?.phrase, []);
});

test("a menu emptied of every action round trips as empty", () => {
  const config = createDefaultCardDesignConfig();
  let items = config.selectionMenus.word;
  let removed = config.removedMenuActions?.word ?? [];
  for (const item of [...items]) {
    ({ items, removed } = removeMenuAction(items, removed, item.id));
  }
  config.selectionMenus.word = items;
  config.removedMenuActions = { ...config.removedMenuActions!, word: removed };

  const reloaded = roundTrip(config);
  assert.deepEqual(reloaded.selectionMenus.word, []);
});

test("restoring menu actions rebuilds the built-ins and keeps custom actions", () => {
  const customId = "custom_menu1" as CustomLearningId;
  const factory = createDefaultCardDesignConfig();
  const custom = {
    id: customId,
    enabled: true,
    name: "Ask twice",
    prompt: "Say it again",
    createdAt: 2,
    updatedAt: 2,
  };
  const { items, removed } = removeMenuAction(
    [custom, ...factory.selectionMenus.word.map((item) => ({ ...item, enabled: false }))],
    [],
    "speak",
  );
  assert.deepEqual(removed, ["speak"]);

  const restored = restoreDefaultMenuActions("word", items);
  assert.deepEqual(
    restored.items.filter((item) => !item.id.startsWith("custom_")),
    factory.selectionMenus.word,
  );
  // translate ships off; a restore must not quietly turn it on.
  assert.equal(restored.items.find((item) => item.id === "translate")?.enabled, false);
  assert.deepEqual(restored.items.filter((item) => item.id.startsWith("custom_")), [custom]);
  assert.deepEqual(restored.removed, []);
});

test("deleting a custom module drops its definition instead of tombstoning it", () => {
  const customId = "custom_gone" as CustomLearningId;
  const factory = createDefaultCardDesignConfig();
  const card = {
    ...factory.cards.word,
    modules: [...factory.cards.word.modules, { id: customId, enabled: true, defaultExpanded: true, density: "inherit" as const }],
    customModules: { [customId]: { name: "Gone", prompt: "Gone", createdAt: 1, updatedAt: 1 } },
  };

  const next = removeCardModule(card, customId);
  assert.ok(!next.modules.some((module) => module.id === customId));
  assert.deepEqual(next.customModules, {});
  assert.deepEqual(next.removedModules, [], "custom ids must never enter the tombstone");
});
