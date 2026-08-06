import assert from "node:assert/strict";
import test from "node:test";

import {
  SETTINGS_ROOT_ROWS,
  groupSettingsRootRows,
  type SettingsRootRow,
} from "../src/components/settings/settings-root-rows.ts";
import type { SettingsSection } from "../src/components/settings-destination.ts";

/**
 * The mobile root list is the one part of the settings shell whose shape is a
 * product decision rather than a layout one — which rows, in which order, under
 * which headings. Asserting it here keeps a refactor of the modal from quietly
 * reordering or dropping an entry.
 */

/** What `isSectionAvailable` answers on a phone: no MCP, iCloud folder sync
 * gates only inside 书库's own sync block now, not the whole section. */
const availableOnPhone = (row: SettingsRootRow) => row.section !== "mcp";

function labels(rows: readonly SettingsRootRow[]): string[] {
  return rows.map((row) => row.id);
}

test("the full root list is ten rows in four groups", () => {
  const groups = groupSettingsRootRows(() => true);
  assert.deepEqual(
    groups.map((group) => [group.id, group.headingKey ?? null, labels(group.rows)]),
    [
      ["core", null, ["general", "reading", "learning", "tools"]],
      ["ai", "settings.groups.ai", ["models", "speech", "autoAnalysis"]],
      ["library", "settings.groups.library", ["library"]],
      ["misc", null, ["mcp", "about"]],
    ],
  );
  assert.equal(groups.flatMap((group) => group.rows).length, 10);
});

test("a section the platform lacks takes its row with it", () => {
  // No MCP on a phone: the last group is 关于 alone rather than a heading
  // over an empty card (it carries no heading in the first place).
  const withoutMcp = groupSettingsRootRows(availableOnPhone);
  const misc = withoutMcp.find((group) => group.id === "misc");
  assert.deepEqual(labels(misc?.rows ?? []), ["about"]);
  assert.equal(withoutMcp.flatMap((group) => group.rows).length, 9);

  const withoutEverything = groupSettingsRootRows(() => false);
  assert.equal(withoutEverything.length, 0);
});

test("every row points at a section the modal can render", () => {
  const sections: SettingsSection[] = [
    "general",
    "reading",
    "learning",
    "services",
    "autoAnalysis",
    "tools",
    "library",
    "mcp",
    "about",
  ];
  for (const row of SETTINGS_ROOT_ROWS) {
    assert.ok(sections.includes(row.section), `${row.id} names an unknown section`);
  }
});

test("no row raises a bottom sheet anymore — 主题 lives inside 通用 now", () => {
  // `Select` auto-sheets itself on a touch device, so the bespoke one-row
  // sheet mechanism the old 外观 section needed no longer has a reason to
  // exist. Every row pushes its own level.
  assert.deepEqual(
    SETTINGS_ROOT_ROWS.filter((row) => row.kind === "sheet").map((row) => row.id),
    [],
  );
  assert.equal(SETTINGS_ROOT_ROWS.every((row) => row.kind === "push"), true);
});

test("the two rows sharing a section are told apart by their view", () => {
  const services = SETTINGS_ROOT_ROWS.filter((row) => row.section === "services");
  assert.deepEqual(services.map((row) => row.view), ["models", "speech"]);
});

test("书籍来源 and 书库同步 merged into one root row", () => {
  const libraryRows = SETTINGS_ROOT_ROWS.filter((row) => row.section === "library");
  assert.equal(libraryRows.length, 1);
  assert.equal(libraryRows[0].id, "library");
});
