import assert from "node:assert/strict";
import test from "node:test";

import { CEFR_LEVELS } from "../src/components/settings/cefr.ts";
import {
  createDefaultCardDesignConfig,
  parseCardDesignConfig,
  serializeCardDesignConfig,
} from "../src/components/learning-card/config.ts";
import {
  LEARNING_CARD_SOURCE_LEVEL,
  LEARNING_CARD_SOURCE_MANUAL,
  LEARNING_CARD_SOURCE_SETTING_KEY,
  cardDesignConfigForLevel,
  cardPresetFollowsLevel,
  isCefrLevel,
} from "../src/components/learning-card/level-presets.ts";
import type { CardDesignConfigV1, LearningCardKind } from "../src/components/learning-card/types.ts";

const enabledIds = (config: CardDesignConfigV1, kind: LearningCardKind) =>
  config.cards[kind].modules.filter((module) => module.enabled).map((module) => module.id);

// 等级只换「显示哪几块」。这三条断言守的是 §2.1 和 §2.2 的两条禁令：不许给初级
// 读者少几块，也不许把双击那一块的密度降下来 —— 那正是双击存在的理由。
test("every level gets the same number of word modules", () => {
  for (const level of CEFR_LEVELS) {
    assert.equal(enabledIds(cardDesignConfigForLevel(level), "word").length, 5, level);
  }
});

test("context_meaning stays detailed at every level", () => {
  for (const level of CEFR_LEVELS) {
    const module = cardDesignConfigForLevel(level).cards.word.modules
      .find((item) => item.id === "context_meaning");
    assert.equal(module?.enabled, true, level);
    assert.equal(module?.density, "detailed", level);
  }
});

test("B2 is the factory default, byte for byte", () => {
  assert.equal(
    serializeCardDesignConfig(cardDesignConfigForLevel("B2")),
    serializeCardDesignConfig(createDefaultCardDesignConfig()),
  );
});

// 预设是要存进 settings 再读回来的，所以它必须能原样穿过解析器 —— 解析器丢掉的
// 模块（比如 id 不在 MODULE_DEFINITIONS 里）会在存盘那一刻悄悄消失。
test("every level's preset survives a save round trip", () => {
  for (const level of CEFR_LEVELS) {
    const preset = cardDesignConfigForLevel(level);
    const stored = parseCardDesignConfig(serializeCardDesignConfig(preset));
    assert.deepEqual(enabledIds(stored, "word"), enabledIds(preset, "word"), level);
    assert.deepEqual(enabledIds(stored, "phrase"), enabledIds(preset, "phrase"), level);
    assert.deepEqual(enabledIds(stored, "passage"), enabledIds(preset, "passage"), level);
  }
});

test("the low levels lead with the sentence, the high levels with word choice", () => {
  for (const level of ["A1", "A2", "B1"] as const) {
    assert.ok(enabledIds(cardDesignConfigForLevel(level), "word").includes("sentence_gist"), level);
  }
  for (const level of ["C1", "C2"] as const) {
    assert.ok(enabledIds(cardDesignConfigForLevel(level), "word").includes("why_this_word"), level);
  }
});

// 没有 learning_card_source 又已经存过卡片配置的，是这个设置存在之前自己动过手
// 的读者 —— 不迁移也不覆盖。
test("cardPresetFollowsLevel never overwrites a reader's own card", () => {
  assert.equal(cardPresetFollowsLevel({}), true);
  assert.equal(
    cardPresetFollowsLevel({ [LEARNING_CARD_SOURCE_SETTING_KEY]: LEARNING_CARD_SOURCE_LEVEL }),
    true,
  );
  assert.equal(
    cardPresetFollowsLevel({ [LEARNING_CARD_SOURCE_SETTING_KEY]: LEARNING_CARD_SOURCE_MANUAL }),
    false,
  );
  assert.equal(cardPresetFollowsLevel({ learning_card_config: "{\"version\":2}" }), false);
  assert.equal(
    cardPresetFollowsLevel({
      learning_card_config: "{\"version\":2}",
      [LEARNING_CARD_SOURCE_SETTING_KEY]: LEARNING_CARD_SOURCE_LEVEL,
    }),
    true,
  );
});

test("isCefrLevel rejects anything that is not one of the six", () => {
  for (const level of CEFR_LEVELS) assert.equal(isCefrLevel(level), true);
  assert.equal(isCefrLevel(undefined), false);
  assert.equal(isCefrLevel(""), false);
  assert.equal(isCefrLevel("b1"), false);
  assert.equal(isCefrLevel("C3"), false);
});
