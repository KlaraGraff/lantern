import assert from "node:assert/strict";
import test from "node:test";

import {
  MENU_ACTION_DEFINITIONS,
  createDefaultCardDesignConfig,
  parseCardDesignConfig,
} from "../src/components/learning-card/config.ts";
import type { SelectionMenuKind } from "../src/components/learning-card/types.ts";

const KINDS: SelectionMenuKind[] = ["word", "phrase", "passage"];

test("every selection menu offers read-aloud, enabled by default", () => {
  const config = createDefaultCardDesignConfig();
  for (const kind of KINDS) {
    assert.ok(
      MENU_ACTION_DEFINITIONS[kind].some((action) => action.id === "speak"),
      `${kind} menu is missing the speak action`,
    );
    const item = config.selectionMenus[kind].find((entry) => entry.id === "speak");
    assert.ok(item, `${kind} default config is missing the speak action`);
    assert.equal(item.enabled, true);
  }
});

// A config saved before the action existed must still surface it, or the
// feature would be invisible to anyone who had already touched these settings.
test("read-aloud appears in a menu config saved before it existed", () => {
  const legacy = {
    version: 2,
    cards: {},
    selectionMenus: {
      word: [
        { id: "define", enabled: true },
        { id: "ask_ai", enabled: true },
        { id: "copy", enabled: true },
      ],
    },
  };

  const parsed = parseCardDesignConfig(legacy);
  const word = parsed.selectionMenus.word;
  const speak = word.find((entry) => entry.id === "speak");

  assert.ok(speak, "speak must be added to a menu that predates it");
  assert.equal(speak.enabled, true);
  // Appended rather than injected, so the user's own ordering is preserved.
  assert.deepEqual(word.slice(0, 3).map((entry) => entry.id), ["define", "ask_ai", "copy"]);
});

test("an explicitly disabled action stays disabled", () => {
  const parsed = parseCardDesignConfig({
    version: 2,
    cards: {},
    selectionMenus: { word: [{ id: "speak", enabled: false }] },
  });
  assert.equal(parsed.selectionMenus.word.find((entry) => entry.id === "speak")?.enabled, false);
});
