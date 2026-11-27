import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { restoreErrorKey } from "../src/components/settings/restore-backup.ts";

const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));

test("every restore error the backend can return has a message in both languages", () => {
  for (const code of [
    "LIBRARY_RESTORE_SYNC_ON",
    "LIBRARY_RESTORE_NO_DATA",
    "LIBRARY_RESTORE_TOO_NEW",
    "LIBRARY_RESTORE_DAMAGED",
    "LIBRARY_BACKUP_FOLDER_OFFLINE",
    "LIBRARY_BACKUP_WRITE_FAILED: disk full",
    "something else",
  ]) {
    const key = restoreErrorKey(code);
    assert.equal(typeof zh[key], "string", key);
    assert.equal(typeof en[key], "string", key);
  }
});

test("a write failure keeps its code, an unknown error falls back", () => {
  assert.equal(
    restoreErrorKey(new Error("LIBRARY_BACKUP_WRITE_FAILED: No space left")),
    "settings.libraryBackup.error.LIBRARY_BACKUP_WRITE_FAILED",
  );
  assert.equal(restoreErrorKey("boom"), "settings.libraryBackup.error.restoreUnknown");
});
