import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCommandSpecs,
  matchRank,
  rankByMatch,
  splitMatch,
  wrapIndex,
} from "../src/components/command-palette/palette-model.ts";
import { isShelfFilter, workspaceOf } from "../src/components/library-actions.ts";

describe("matchRank", () => {
  test("orders exact, prefix, word start, then anywhere", () => {
    assert.equal(matchRank("revere", "revere"), 0);
    assert.equal(matchRank("Reverent", "rev"), 1);
    assert.equal(matchRank("The Reverend", "rev"), 2);
    assert.equal(matchRank("irreverent", "rev"), 3);
    assert.equal(matchRank("caravan", "rev"), -1);
  });

  test("ignores case and surrounding space; an empty query matches", () => {
    assert.equal(matchRank("Willows", "  wIL "), 1);
    assert.equal(matchRank("anything", "   "), 0);
  });
});

test("rankByMatch keeps the best matches, stable within a rank, capped", () => {
  const words = ["irreverent", "reverie", "reverent", "caravan", "The Reverend", "revel", "revenge", "review"];
  assert.deepEqual(rankByMatch(words, "rev", (w) => w), ["reverie", "reverent", "revel", "revenge", "review"]);
  assert.deepEqual(rankByMatch(words, "rev", (w) => w, 10).slice(5), ["The Reverend", "irreverent"]);
  assert.deepEqual(rankByMatch(words, "zzz", (w) => w), []);
});

test("splitMatch cuts around the first occurrence, keeping the original case", () => {
  assert.deepEqual(splitMatch("The Wind in the Willows", "wi"), ["The ", "Wi", "nd in the Willows"]);
  assert.deepEqual(splitMatch("caravan", "rev"), ["caravan", "", ""]);
  assert.deepEqual(splitMatch("caravan", ""), ["caravan", "", ""]);
});

test("wrapIndex wraps at both ends and survives an empty list", () => {
  assert.equal(wrapIndex(0, -1, 4), 3);
  assert.equal(wrapIndex(3, 1, 4), 0);
  assert.equal(wrapIndex(1, 1, 4), 2);
  assert.equal(wrapIndex(5, 1, 0), 0);
});

describe("buildCommandSpecs", () => {
  const sections = ["general", "services", "mcp", "about"];

  test("offers the opposite theme of the current one", () => {
    const toTheme = (isDark: boolean) =>
      buildCommandSpecs({ isDark, hasMcp: true, settingsSections: sections }).find((c) => c.kind === "theme");
    assert.deepEqual(toTheme(false), { id: "cmd:theme", kind: "theme", to: "dark" });
    assert.deepEqual(toTheme(true), { id: "cmd:theme", kind: "theme", to: "light" });
  });

  test("drops the MCP settings section where the platform has none", () => {
    const settingsOf = (hasMcp: boolean) =>
      buildCommandSpecs({ isDark: false, hasMcp, settingsSections: sections })
        .flatMap((c) => (c.kind === "settings" ? [c.section] : []));
    assert.deepEqual(settingsOf(true), sections);
    assert.deepEqual(settingsOf(false), ["general", "services", "about"]);
  });

  test("every command id is unique", () => {
    const ids = buildCommandSpecs({ isDark: false, hasMcp: true, settingsSections: sections }).map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test("every shelf filter belongs to the library workspace, nothing else does", () => {
  for (const filter of ["all", "reading", "finished", "collection:abc"]) {
    assert.ok(isShelfFilter(filter), filter);
    assert.equal(workspaceOf(filter), "all");
  }
  for (const filter of ["vocab", "notes", "qa", "stats"]) {
    assert.ok(!isShelfFilter(filter), filter);
    assert.equal(workspaceOf(filter), filter);
  }
});
