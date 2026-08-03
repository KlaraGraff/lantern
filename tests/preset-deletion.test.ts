import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { presetDeleteConfirm } from "../src/components/settings/presetDeletion.ts";

// The four rows of the table in docs/impls/deletable-preset-items.md §3.2.
test("only an emptied list or a lost custom prompt is worth a dialog", () => {
  assert.equal(presetDeleteConfirm("builtin", false, "card", "Collocations"), null);

  assert.deepEqual(presetDeleteConfirm("builtin", true, "card", "Collocations"), {
    titleKey: "settings.presets.deleteLastTitle",
    descriptionKeys: ["settings.presets.deleteLastCard"],
  });

  assert.deepEqual(presetDeleteConfirm("custom", false, "menu", "Ask twice"), {
    titleKey: "settings.presets.deleteTitle",
    descriptionKeys: ["settings.presets.deleteCustomWarning"],
    nameParam: "Ask twice",
  });

  assert.deepEqual(presetDeleteConfirm("custom", true, "menu", "Ask twice"), {
    titleKey: "settings.presets.deleteLastTitle",
    // Both consequences, warning first.
    descriptionKeys: ["settings.presets.deleteCustomWarning", "settings.presets.deleteLastMenu"],
  });
});

test("each surface names its own consequence", () => {
  const lastKeyFor = (surface: "card" | "menu" | "sources") =>
    presetDeleteConfirm("builtin", true, surface)?.descriptionKeys;
  assert.deepEqual(lastKeyFor("card"), ["settings.presets.deleteLastCard"]);
  assert.deepEqual(lastKeyFor("menu"), ["settings.presets.deleteLastMenu"]);
  assert.deepEqual(lastKeyFor("sources"), ["settings.presets.deleteLastSources"]);
});

// These keys are looked up through variables, so the literal-key scan in
// i18n-keys.test.ts cannot see them and a typo here would surface as raw key
// text in a dialog nobody opens until they are deleting something.
test("every key the helper can return is translated", () => {
  const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
  const tables = ["en.json", "zh.json"].map((locale) => [
    locale,
    JSON.parse(readFileSync(path.join(i18nDir, locale), "utf8")) as Record<string, string>,
  ] as const);

  const keys = new Set<string>();
  for (const kind of ["builtin", "custom"] as const) {
    for (const isLast of [false, true]) {
      for (const surface of ["card", "menu", "sources"] as const) {
        const confirmation = presetDeleteConfirm(kind, isLast, surface, "x");
        if (!confirmation) continue;
        keys.add(confirmation.titleKey);
        for (const key of confirmation.descriptionKeys) keys.add(key);
      }
    }
  }
  keys.add("settings.presets.restore");
  keys.add("settings.presets.restoreHint");
  keys.add("settings.presets.emptyCard");
  keys.add("settings.presets.emptyMenu");

  const missing: string[] = [];
  for (const key of keys) {
    for (const [locale, table] of tables) {
      if (!(key in table)) missing.push(`${key} — missing from ${locale}`);
    }
  }
  assert.deepEqual(missing, []);
});
