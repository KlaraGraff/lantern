import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSettingsDestination,
  settingsDestinationSection,
  settingsDestinationView,
} from "../src/components/settings-destination.ts";

/**
 * Every deep link into Settings — the reader's 生词辅助 link, the OCR nudge,
 * a persisted last-open section, Cmd+`, — goes through this normalizer. The
 * IA reorg renamed and merged several sections; this file is the one place
 * an old, persisted, or externally-stored name still has to resolve.
 */

test("current section names resolve to themselves", () => {
  for (const id of ["general", "reading", "learning", "services", "autoAnalysis", "tools", "library", "mcp", "about"]) {
    assert.equal(normalizeSettingsDestination(id), id);
  }
});

test("外观 folded into 通用 — the old name still lands there", () => {
  assert.equal(normalizeSettingsDestination("appearance"), "general");
});

test("书籍来源 and 书库同步 merged into 书库 — both old names redirect", () => {
  assert.equal(normalizeSettingsDestination("librarySync"), "library");
  assert.equal(normalizeSettingsDestination("bookSources"), "library");
});

test("阅读辅助's pre-rename aliases still resolve to 划词与卡片 (id unchanged)", () => {
  assert.equal(normalizeSettingsDestination("lookup"), "tools");
  assert.equal(normalizeSettingsDestination("translation"), "tools");
});

test("服务配置's pre-rename alias still resolves (id unchanged)", () => {
  assert.equal(normalizeSettingsDestination("ai"), "services");
});

test("scanned-PDF OCR moved from 阅读辅助 into AI 配置, view included", () => {
  assert.deepEqual(
    normalizeSettingsDestination({ section: "tools", view: "ocr" }),
    { section: "services", view: "ocr" },
  );
});

test("an unrecognized value opens at root rather than throwing", () => {
  assert.equal(normalizeSettingsDestination("not-a-section"), "root");
  assert.equal(normalizeSettingsDestination(undefined), "root");
  assert.equal(normalizeSettingsDestination(null), "root");
  assert.equal(normalizeSettingsDestination(42), "root");
});

test("a view only survives normalization on the section that owns it", () => {
  assert.deepEqual(
    normalizeSettingsDestination({ section: "services", view: "models" }),
    { section: "services", view: "models" },
  );
  assert.deepEqual(
    normalizeSettingsDestination({ section: "reading", view: "passiveVocab" }),
    { section: "reading", view: "passiveVocab" },
  );
  // 学习 has no views of its own — a view meant for another section does not
  // leak through just because the section name resolves.
  assert.equal(
    normalizeSettingsDestination({ section: "learning", view: "models" }),
    "learning",
  );
});

test("settingsDestinationSection / settingsDestinationView unwrap every shape", () => {
  assert.equal(settingsDestinationSection("root"), undefined);
  assert.equal(settingsDestinationSection("general"), "general");
  assert.equal(settingsDestinationSection({ section: "services", view: "models" }), "services");

  assert.equal(settingsDestinationView("root"), undefined);
  assert.equal(settingsDestinationView("general"), undefined);
  assert.equal(settingsDestinationView({ section: "services", view: "models" }), "models");
});
