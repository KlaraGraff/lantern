import assert from "node:assert/strict";
import test from "node:test";

import { isResetConfirmed, runReset } from "../src/components/settings/reset-data.ts";

test("only the exact word RESET unlocks the reset", () => {
  assert.equal(isResetConfirmed("RESET"), true);
  assert.equal(isResetConfirmed("  RESET\n"), true);
  for (const typed of ["", "reset", "Reset", "RESE", "RESETT", "R E S E T", "重置"]) {
    assert.equal(isResetConfirmed(typed), false, typed);
  }
});

test("a failed request clears nothing and does not relaunch", async () => {
  const calls: string[] = [];
  const result = await runReset({
    request: async () => { calls.push("request"); throw new Error("boom"); },
    clearWebStorage: () => { calls.push("clear"); },
    relaunch: async () => { calls.push("relaunch"); },
  });
  assert.equal(result, "request-failed");
  assert.deepEqual(calls, ["request"]);
});

test("a successful request clears web storage before relaunching", async () => {
  const calls: string[] = [];
  const result = await runReset({
    request: async () => { calls.push("request"); },
    clearWebStorage: () => { calls.push("clear"); },
    relaunch: async () => { calls.push("relaunch"); },
  });
  assert.equal(result, "relaunching");
  assert.deepEqual(calls, ["request", "clear", "relaunch"]);
});

test("a failed relaunch is reported, not swallowed", async () => {
  const result = await runReset({
    request: async () => {},
    clearWebStorage: () => { throw new Error("storage blocked"); },
    relaunch: async () => { throw new Error("no relaunch"); },
  });
  assert.equal(result, "relaunch-failed");
});
