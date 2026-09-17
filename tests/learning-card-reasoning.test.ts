import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepo = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("a cache miss opens the learning card reasoning region before the first token", async () => {
  const controller = await readRepo("src/components/learning-card/LearningCardController.tsx");
  const cacheMiss = controller.indexOf("setThinking(true);", controller.indexOf("if (retry === 0 && bookId)"));
  const streamListener = controller.indexOf("unlisten = await listen<LearningCardStreamChunk>");

  assert.ok(cacheMiss > 0, "a cache miss should enter the thinking state");
  assert.ok(cacheMiss < streamListener, "thinking must be visible before the stream can emit reasoning");
});

test("the learning card shows preparation, streams reasoning, and closes when the answer starts", async () => {
  const view = await readRepo("src/components/learning-card/LearningCardView.tsx");

  assert.match(view, /const showReasoning = thinking \|\| hasReasoning/);
  assert.match(view, /!reasoningWasInProgress\.current && thinking/);
  assert.match(view, /setReasoningExpanded\(null\)/);
  assert.match(view, /reasoningWasInProgress\.current && !thinking/);
  assert.match(view, /setReasoningExpanded\(false\)/);
  assert.match(view, /ref=\{reasoningRef\}/);
  assert.match(view, /aria-busy=\{thinking\}/);
  assert.match(view, /aria-label=\{t\("ai\.thinking"\)\}/);
});
