import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import type { useAiChat } from "../src/hooks/useAiChat.ts";

type Chat = ReturnType<typeof useAiChat>;
type Args = Record<string, any>;
type Handler = (args: Args) => unknown;

// Execute the actual hook, with deferred Tauri responses and a small hook host.
// State updates remain queued until render(), exercising calls made before React
// commits a render as well as overlapping backend requests.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/hooks/useAiChat.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [{
    name: "chat-test-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^(react|@tauri-apps\/api\/(core|event))$|^\.\/useSettings$/ }, ({ path }) => ({ path, namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents:
        path === "react"
          ? "export const { useState, useRef, useCallback, useEffect, useLayoutEffect } = globalThis.host;"
          : path === "./useSettings"
            ? 'export const useSettings = () => ({ settings: { ai_summaries_auto: "false" }, save: async () => {} });'
            : "export const { invoke, listen } = globalThis.host;",
      }));
    },
  }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function history(id: string, question = `question ${id}`) {
  return [
    { id: `${id}-user`, role: "user", content: question, context: "book passage", metadata: null },
    { id: `${id}-assistant`, role: "assistant", content: `answer ${id}`, context: null, metadata: null },
  ];
}

function harness() {
  const slots: any[] = [];
  const pending: (() => void)[] = [];
  const effects: (() => void)[] = [];
  const calls: { command: string; args: Args }[] = [];
  const listeners = new Map<string, (event: { payload: any }) => unknown>();
  const handlers: Record<string, Handler> = {
    list_chats: () => [],
    list_chat_messages: ({ chatId }) => history(chatId),
    get_book_ai_state: () => null,
    ai_chat: () => ({}),
    save_chat_message: () => ({ id: `saved-${calls.length}` }),
    create_chat: () => ({ id: "created", title: "New chat" }),
    get_chat: () => ({ title: "Already named" }),
    ai_generate_title: () => "Title",
  };
  let cursor = 0;
  let nextUuid = 0;
  const memo = (value: unknown, deps: unknown[]) => {
    const index = cursor++;
    const previous = slots[index];
    const changed = !previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
    if (changed) slots[index] = { ...previous, value, deps };
    return { index, changed, value: slots[index].value };
  };
  const effect = (callback: () => unknown, deps: unknown[]) => {
    const { index, changed } = memo(callback, deps);
    if (changed) effects.push(() => {
      slots[index].cleanup?.();
      slots[index].cleanup = callback();
    });
  };
  const host = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => pending.push(() => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
      })];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback: (callback: unknown, deps: unknown[]) => memo(callback, deps).value,
    useEffect: effect,
    useLayoutEffect: effect,
    async invoke(command: string, args: Args = {}) {
      calls.push({ command, args });
      return handlers[command]?.(args);
    },
    async listen(name: string, listener: (event: { payload: any }) => unknown) {
      listeners.set(name, listener);
      return () => { listeners.delete(name); };
    },
  };
  const module = { exports: {} as { useAiChat: typeof useAiChat } };
  runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, host,
    crypto: { randomUUID: () => `request-${++nextUuid}` },
    console: { error() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout, clearTimeout,
  });
  const render = (bookId = "book") => {
    pending.splice(0).forEach((update) => update());
    cursor = 0;
    const result = module.exports.useAiChat(bookId);
    effects.splice(0).forEach((run) => run());
    return result;
  };
  return {
    calls, handlers, render,
    async ready() {
      const chat = render();
      await chat.initialize();
      await chat.loadChat("A");
      return render();
    },
    async stream(payload: unknown) {
      const listener = [...listeners].find(([name]) => name.startsWith("ai-stream-chunk-"))?.[1];
      assert.ok(listener, "stream listener must be registered");
      await listener({ payload });
    },
    requests: () => calls.filter(({ command }) => command === "ai_chat"),
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("history loading blocks sending before render and publishes only the new context", async () => {
  const h = harness();
  const chat = await h.ready();
  const load = deferred<ReturnType<typeof history>>();
  h.handlers.list_chat_messages = () => load.promise;
  const switching = chat.loadChat("B");
  await chat.send("must wait");
  assert.equal(h.requests().length, 0);
  assert.equal(h.render().initializing, true);
  assert.equal(h.render().chatId, "A");
  load.resolve(history("B"));
  await switching;
  // Send immediately, before the transcript's React state update commits.
  await chat.send("follow up");
  const request = h.requests()[0].args;
  assert.match(JSON.stringify(request.messages), /question B/);
  assert.doesNotMatch(JSON.stringify(request.messages), /question A|must wait/);
  assert.equal(h.calls.find(({ command }) => command === "save_chat_message")?.args.chatId, "B");
  assert.equal(h.render().initializing, false);
});

test("A to B to A reload ignores stale same-chat results and keeps the newest load gated", async () => {
  const h = harness();
  const chat = await h.ready();
  const first = deferred<ReturnType<typeof history>>();
  const middle = deferred<ReturnType<typeof history>>();
  const latest = deferred<ReturnType<typeof history>>();
  const queue = [first, middle, latest];
  h.handlers.list_chat_messages = () => queue.shift()!.promise;
  const a1 = chat.loadChat("A");
  const b = chat.loadChat("B");
  const a2 = chat.loadChat("A");
  first.resolve(history("A", "stale"));
  middle.reject(new Error("stale failure"));
  await Promise.all([a1, b]);
  assert.equal(h.render().initializing, true);
  await chat.send("blocked");
  assert.equal(h.requests().length, 0);
  latest.resolve(history("A", "fresh"));
  await a2;
  assert.equal(h.render().messages[0].content, "fresh");
  assert.equal(h.render().initializing, false);
});

test("failed navigation retains a matching chat identity and history", async () => {
  const h = harness();
  const chat = await h.ready();
  h.handlers.list_chat_messages = () => Promise.reject(new Error("read failed"));
  await chat.loadChat("B");
  assert.equal(h.render().initializing, false);
  assert.equal(h.render().chatId, "A");
  await chat.send("continue A");
  assert.match(JSON.stringify(h.requests()[0].args.messages), /question A/);
  assert.equal(h.calls.find(({ command }) => command === "save_chat_message")?.args.chatId, "A");
});

test("reset invalidates an in-flight history read", async () => {
  const h = harness();
  const chat = await h.ready();
  const load = deferred<ReturnType<typeof history>>();
  h.handlers.list_chat_messages = () => load.promise;
  const switching = chat.loadChat("B");
  await chat.reset();
  load.resolve(history("B"));
  await switching;
  assert.equal(h.render().chatId, null);
  assert.equal(h.render().messages.length, 0);
  assert.equal(h.render().initializing, false);
});

test("late lazy creation cannot overwrite a chat selected while it was pending", async () => {
  const h = harness();
  const chat = await h.ready();
  await chat.reset();
  const created = deferred<{ id: string }>();
  h.handlers.create_chat = () => created.promise;
  const sending = chat.send("new question");
  await chat.loadChat("B");
  created.resolve({ id: "late-created" });
  await sending;
  assert.equal(h.render().chatId, "B");
  assert.equal(h.render().messages[0].content, "question B");
  assert.equal(h.requests().length, 0);
});

test("alias replacement sends the chosen canonical and quote without rewriting the original user", async () => {
  const h = harness();
  const chat = await h.ready();
  chat.swapAlias("A-assistant", "Elizabeth Bennet");
  await settle();
  const request = h.requests()[0].args;
  assert.equal(request.messages.length, 1);
  assert.match(request.messages[0].content, /^question A Elizabeth Bennet\n/);
  assert.match(request.messages[0].content, /\[Selected passage\]\nbook passage/);
  assert.equal(h.render().messages[0].content, "question A");
  await h.stream({ delta: "corrected answer", done: false });
  await h.stream({ delta: "", done: true });
  assert.equal(h.render().messages[1].content, "corrected answer");
  assert.equal(h.calls.filter(({ command }) => command === "save_chat_message").length, 0);
  const replaced = h.calls.find(({ command }) => command === "replace_chat_message");
  assert.equal(replaced?.args.messageId, "A-assistant");
  assert.equal(replaced?.args.content, "corrected answer");
});

test("failed alias regeneration restores the previous answer", async () => {
  const h = harness();
  const chat = await h.ready();
  h.handlers.ai_chat = () => Promise.reject(new Error("model failure"));
  chat.swapAlias("A-assistant", "Elizabeth Bennet");
  await settle();
  assert.equal(h.render().messages[1].content, "answer A");
  assert.equal(h.render().streaming, false);
});

test("switching away cancels alias regeneration and restores the old answer if loading fails", async () => {
  const h = harness();
  const chat = await h.ready();
  const result = deferred<unknown>();
  h.handlers.ai_chat = () => result.promise;
  chat.swapAlias("A-assistant", "Elizabeth Bennet");
  await settle();
  await h.stream({ delta: "partial replacement", done: false });
  h.handlers.list_chat_messages = () => Promise.reject(new Error("read failed"));
  await chat.loadChat("B");
  result.resolve({});
  await settle();
  assert.equal(h.render().messages[1].content, "answer A");
  assert.equal(h.render().chatId, "A");
  assert.ok(h.calls.some(({ command }) => command === "ai_cancel"));
});

test("manual navigation wins over initialization that is still listing chats", async () => {
  const h = harness();
  const chat = h.render();
  const listed = deferred<{ id: string }[]>();
  h.handlers.list_chats = () => listed.promise;
  const initializing = chat.initialize();
  await chat.loadChat("chosen");
  listed.resolve([{ id: "latest-but-not-chosen" }]);
  await initializing;
  assert.equal(h.render().chatId, "chosen");
  assert.equal(h.render().initializing, false);
});

test("changing books clears the old conversation even when the new history fails", async () => {
  const h = harness();
  const oldChat = await h.ready();
  const stale = deferred<ReturnType<typeof history>>();
  h.handlers.list_chat_messages = () => stale.promise;
  const staleLoad = oldChat.loadChat("old-pending");
  const newChat = h.render("other-book");
  h.handlers.list_chats = () => [{ id: "new-book-chat" }];
  h.handlers.list_chat_messages = () => Promise.reject(new Error("read failed"));
  await newChat.initialize();
  stale.resolve(history("old-pending"));
  await staleLoad;
  assert.equal(h.render("other-book").chatId, null);
  assert.equal(h.render("other-book").messages.length, 0);
  assert.equal(h.render("other-book").initializing, false);
});

test("cancelling alias regeneration restores the previous answer before another send", async () => {
  const h = harness();
  const chat = await h.ready();
  const response = deferred<unknown>();
  h.handlers.ai_chat = () => response.promise;
  chat.swapAlias("A-assistant", "Elizabeth Bennet");
  await settle();
  chat.cancel();
  h.handlers.ai_chat = () => ({});
  await chat.send("follow up after cancellation");
  assert.equal(h.requests()[1].args.messages[1].content, "answer A");
  response.resolve({});
  await settle();
  assert.equal(h.render().messages[1].content, "answer A");
});
