/**
 * Pure pieces of 从备份恢复, kept free of React and Tauri so they run under
 * the plain `node:test` runner (see tests/restore-backup.test.ts).
 */

const RESTORE_ERRORS = [
  "LIBRARY_RESTORE_SYNC_ON",
  "LIBRARY_RESTORE_NO_DATA",
  "LIBRARY_RESTORE_TOO_NEW",
  "LIBRARY_RESTORE_DAMAGED",
  "LIBRARY_BACKUP_FOLDER_OFFLINE",
  "LIBRARY_BACKUP_WRITE_FAILED",
];

/** The i18n key for a failed restore; anything unrecognised reads as "try again". */
export function restoreErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = RESTORE_ERRORS.find((candidate) => message.includes(candidate));
  return `settings.libraryBackup.error.${code ?? "restoreUnknown"}`;
}
