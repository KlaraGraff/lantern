import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  startupFailureActions,
  startupFailureCopy,
  type FailedStore,
  type FailureReason,
  type StartupFailureInfo,
} from "../src/components/startup-failure.ts";

const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));

const STORES: FailedStore[] = ["library", "secrets"];
const REASONS: FailureReason[] = ["damaged", "disk_full", "no_access", "unknown"];

const info = (overrides: Partial<StartupFailureInfo>): StartupFailureInfo => ({
  store: "library",
  reason: "damaged",
  detail: "Database error: file is not a database",
  can_restore: true,
  ...overrides,
});

test("every store and reason the backend sends has its title and body in both languages", () => {
  for (const store of STORES) {
    for (const reason of REASONS) {
      const { titleKey, bodyKey } = startupFailureCopy(info({ store, reason }));
      for (const key of [titleKey, bodyKey]) {
        assert.equal(typeof zh[key], "string", `zh ${key}`);
        assert.equal(typeof en[key], "string", `en ${key}`);
      }
    }
  }
  for (const key of [
    "startupFailure.restoreHint",
    "startupFailure.restore",
    "startupFailure.relaunch",
    "startupFailure.showLogs",
    "startupFailure.relaunchFailed",
  ]) {
    assert.equal(typeof zh[key], "string", `zh ${key}`);
    assert.equal(typeof en[key], "string", `en ${key}`);
  }
});

test("a damaged library leads with restoring from a backup", () => {
  assert.deepEqual(startupFailureActions(info({})), ["restore", "relaunch", "logs"]);
});

test("a full disk or a permission problem leads with reopening, restore still offered", () => {
  assert.deepEqual(startupFailureActions(info({ reason: "disk_full" })), ["relaunch", "restore", "logs"]);
  assert.deepEqual(startupFailureActions(info({ reason: "no_access" })), ["relaunch", "restore", "logs"]);
});

test("no restore when the backend says it cannot help", () => {
  for (const reason of REASONS) {
    const actions = startupFailureActions(info({ store: "secrets", reason, can_restore: false }));
    assert.ok(!actions.includes("restore"), reason);
  }
  assert.deepEqual(startupFailureActions(info({ can_restore: false })), ["relaunch", "logs"]);
});
