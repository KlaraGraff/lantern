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

/** What `isSectionAvailable` answers on a phone: no MCP, iCloud folder sync. */
const availableOnPhone = (row: SettingsRootRow) => row.section !== "mcp";

function labels(rows: readonly SettingsRootRow[]): string[] {
  return rows.map((row) => row.id);
}

test("the phone's root list is ten rows in four groups", () => {
  const groups = groupSettingsRootRows(availableOnPhone);
  assert.deepEqual(
    groups.map((group) => [group.id, group.headingKey ?? null, labels(group.rows)]),
    [
      ["core", null, ["general", "theme", "reading", "tools"]],
      ["ai", "settings.groups.ai", ["models", "speech", "autoAnalysis"]],
      ["library", "settings.groups.library", ["librarySync", "bookSources"]],
      ["misc", null, ["about"]],
    ],
  );
  assert.equal(groups.flatMap((group) => group.rows).length, 10);
});

test("a section the platform lacks takes its row with it", () => {
  // Windows has no folder sync; the 书库 group is then 书籍来源 alone rather
  // than a heading over an empty card.
  const withoutSync = groupSettingsRootRows((row) => row.section !== "librarySync");
  const library = withoutSync.find((group) => group.id === "library");
  assert.deepEqual(labels(library?.rows ?? []), ["bookSources"]);

  const withoutEither = groupSettingsRootRows(
    (row) => row.section !== "librarySync" && row.section !== "bookSources",
  );
  assert.equal(withoutEither.some((group) => group.id === "library"), false);
});

test("every row points at a section the modal can render", () => {
  const sections: SettingsSection[] = [
    "general",
    "appearance",
    "reading",
    "services",
    "autoAnalysis",
    "tools",
    "librarySync",
    "bookSources",
    "mcp",
    "about",
  ];
  for (const row of SETTINGS_ROOT_ROWS) {
    assert.ok(sections.includes(row.section), `${row.id} names an unknown section`);
  }
});

test("only a section with one control opens in place", () => {
  // The rule the mock-up's two chevron directions encode: a right chevron
  // pushes a level, a down chevron raises a sheet. 外观 is the only section
  // holding exactly one control, so it is the only sheet.
  assert.deepEqual(
    SETTINGS_ROOT_ROWS.filter((row) => row.kind === "sheet").map((row) => row.id),
    ["theme"],
  );
});

test("the two rows sharing a section are told apart by their view", () => {
  const services = SETTINGS_ROOT_ROWS.filter((row) => row.section === "services");
  assert.deepEqual(services.map((row) => row.view), ["models", "speech"]);
});
