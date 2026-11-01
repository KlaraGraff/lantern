import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepo = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The body of a top-level `const <name> = ...` whose value is an arrow
 *  function, brace-matched. Components here are React, so the behaviour has to
 *  be pinned on the source the way `tests/ai-panel-selection.test.ts` does. */
function arrowBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test("a system theme change never overrides the reader's explicit light/dark pick", async () => {
  const app = await readRepo("src/App.tsx");
  const handler = arrowBody(app, "handler");

  // The picker (GeneralSettings, CommandPalette) mirrors the choice into
  // `lantern-theme`; the OS listener must consult it rather than a document
  // flag nothing ever writes — otherwise 浅色 flips to dark at sunset.
  assert.match(handler, /lantern-theme/);
  assert.doesNotMatch(handler, /themeOverride/);
  assert.match(handler, /applyTheme\("system"\)/);

  // And the mirror really is written by every theme picker.
  const [general, palette] = await Promise.all([
    readRepo("src/components/settings/GeneralSettings.tsx"),
    readRepo("src/components/command-palette/CommandPalette.tsx"),
  ]);
  assert.match(general, /localStorage\.setItem\("lantern-theme", value\)/);
  assert.match(palette, /localStorage\.setItem\("lantern-theme", spec\.to\)/);
});

test("the chat a reader arrived with is loaded once, not again when the chat list grows", async () => {
  const panel = await readRepo("src/components/AiPanel.tsx");
  const effect = panel.slice(
    panel.indexOf("// Load specific chat when navigating from ChatsPage"),
    panel.indexOf("// Focus title input when editing"),
  );

  assert.ok(effect.length > 0, "arrival-chat effect not found");
  assert.match(effect, /arrivalChatLoadedRef/);
  assert.match(effect, /arrivalChatLoadedRef\.current === initialChatId\) return;/);
  // Sending the first message creates a chat, which grows `chats` — that must
  // not reload the arrival chat over the answer being streamed.
  assert.match(panel, /\}, \[initialChatId, chats\.length, loadChat\]\);/);
});
