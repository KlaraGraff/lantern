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

test("chat reasoning opens while preparing and closes when the answer starts", async () => {
  const bubble = await readRepo("src/components/MessageBubble.tsx");

  assert.match(bubble, /const reasoningInProgress = msg\.role === "assistant" && streaming && isLast && !msg\.content/);
  assert.match(bubble, /const showReasoning = hasReasoning \|\| reasoningInProgress/);
  assert.match(bubble, /reasoningWasInProgress\.current && !reasoningInProgress/);
  assert.match(bubble, /setReasoningExpanded\(false\)/);
  assert.match(bubble, /ref=\{reasoningRef\}/);
  assert.match(bubble, /aria-label=\{t\("ai\.thinking"\)\}/);
});

test("selection context routes by exact position and user preferences", async () => {
  const [panel, reader, chat] = await Promise.all([
    readRepo("src/components/AiPanel.tsx"),
    readRepo("src/pages/Reader.tsx"),
    readRepo("src/hooks/useAiChat.ts"),
  ]);

  assert.match(reader, /active=\{sidePanel === "ai"\}/);
  assert.match(panel, /if \(!context\.cfi\) \{\s*addQuote\(context\)/);
  assert.match(panel, /resumeChatAtSamePassage\s*\? await findChatIdByContextCfi\(context\.cfi as string\)/);
  assert.match(panel, /passageRoute\(wasActive, visibleChatIdRef\.current, matchedChatId/);
  assert.match(panel, /route === "resume"/);
  assert.match(panel, /route === "new"/);
  assert.match(chat, /invoke<ChatRecord \| null>\("find_chat_by_context_cfi"/);
});

test("composer quote identity prefers position over display text", async () => {
  const panel = await readRepo("src/components/AiPanel.tsx");

  assert.match(panel, /return quote\.cfi \? `passage:\$\{quote\.cfi\}`/);
  assert.match(panel, /quoteIdentity\(item\) === quoteIdentity\(quote\)/);
});

test("the standalone reader book mark opens the main library", async () => {
  const reader = await readRepo("src/pages/Reader.tsx");

  assert.match(reader, /invoke\("open_library_on_main", \{ filter: "all" \}\)/);
  assert.ok(
    reader.split("onClick={openMainLibrary}").length - 1 >= 3,
    "every standalone header variant must expose the return action",
  );
});
