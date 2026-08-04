import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// paginator.js is a browser module, but these two navigation primitives are
// deliberately DOM-free so the chapter-boundary races stay deterministic.
Object.assign(globalThis, {
  NodeFilter: {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    SHOW_CDATA_SECTION: 8,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  },
  HTMLElement: class {},
  customElements: { define() {} },
});

const { PageTurnQueue, isTargetFrameDocument } = await import(
  "../public/foliate-js/paginator.js"
) as {
  PageTurnQueue: new () => { run<T>(task: () => Promise<T>): Promise<T> };
  isTargetFrameDocument: (doc: { URL?: string; body?: object } | null, src: string) => boolean;
};

test("ignores the iframe's initial about:blank load before a chapter document", () => {
  const src = "blob:https://reader.local/chapter-2";

  assert.equal(isTargetFrameDocument({ URL: "about:blank", body: {} }, src), false);
  assert.equal(isTargetFrameDocument({ URL: src, body: {} }, src), true);
  assert.equal(isTargetFrameDocument({ URL: src }, src), true);
});

test("starts the chapter navigation before connecting its iframe", async () => {
  const source = await readFile(
    new URL("../public/foliate-js/paginator.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const loading = view.load(src, afterLoad, beforeRender)");
  const mount = source.indexOf("this.#container.append(view.element)", start);
  const waitForLoad = source.indexOf("await loading", mount);

  assert.ok(start >= 0 && start < mount && mount < waitForLoad);
});

test("queues a rapid second page turn while the chapter boundary is loading", async () => {
  const queue = new PageTurnQueue();
  const events: string[] = [];
  let releaseChapter!: () => void;
  const chapterLoaded = new Promise<void>((resolve) => {
    releaseChapter = resolve;
  });

  const first = queue.run(async () => {
    events.push("first:start");
    await chapterLoaded;
    events.push("first:end");
  });
  const second = queue.run(async () => {
    events.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseChapter();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("runs the next page turn after a chapter load fails", async () => {
  const queue = new PageTurnQueue();
  const failed = queue.run(async () => {
    throw new Error("chapter load failed");
  });
  const retried = queue.run(async () => "loaded");

  await assert.rejects(failed, /chapter load failed/u);
  assert.equal(await retried, "loaded");
});
