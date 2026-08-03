import assert from "node:assert/strict";
import test from "node:test";

import { disposeFoliateViewAfterInitialization } from "../src/pages/reader/foliate-view-lifecycle.ts";

test("detaches a cancelled Foliate view before closing it after initialization", async () => {
  const calls: string[] = [];
  let finishInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  const view = {
    remove: () => calls.push("remove"),
    close: () => calls.push("close"),
  };

  disposeFoliateViewAfterInitialization(view, initialization, assert.fail);
  assert.deepEqual(calls, ["remove"]);

  finishInitialization();
  await initialization;
  await Promise.resolve();
  assert.deepEqual(calls, ["remove", "close"]);
});

test("reports teardown errors instead of turning effect cleanup into a white screen", async () => {
  const expected = new Error("not initialized");
  let reported: unknown;

  disposeFoliateViewAfterInitialization({
    remove() {},
    close() {
      throw expected;
    },
  }, Promise.resolve(), (error) => {
    reported = error;
  });
  await Promise.resolve();

  assert.equal(reported, expected);
});
