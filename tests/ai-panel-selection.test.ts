import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepo = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("opening the selection menu leaves settled answer DOM mounted", async () => {
  const [bubble, reader] = await Promise.all([
    readRepo("src/components/MessageBubble.tsx"),
    readRepo("src/pages/Reader.tsx"),
  ]);

  assert.match(bubble, /export default memo\(MessageBubble\)/);
  assert.match(reader, /const navigateToQuotedSource = useCallback/);
  assert.match(reader, /onNavigateToQuote=\{navigateToQuotedSource\}/);
});

test("a selection from outside the composer replaces the previous chat context", async () => {
  const panel = await readRepo("src/components/AiPanel.tsx");
  const start = panel.indexOf("if (!context) return;");
  const effect = panel.slice(start, panel.indexOf("}, [context", start));

  assert.match(effect, /void reset\(\)/);
  assert.match(effect, /setPendingQuotes\(\[context\]\)/);
  assert.match(effect, /setAutoQuote\(undefined\)/);
});

test("the standalone reader book mark opens the main library", async () => {
  const reader = await readRepo("src/pages/Reader.tsx");

  assert.match(reader, /invoke\("open_library_on_main", \{ filter: "all" \}\)/);
  assert.ok(
    reader.split("onClick={openMainLibrary}").length - 1 >= 3,
    "every standalone header variant must expose the return action",
  );
});
