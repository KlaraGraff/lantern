/**
 * Mock of `@tauri-apps/plugin-dialog`.
 *
 * Every picker resolves to `null` — "the user cancelled". That is the branch a
 * sweep wants: it is reachable without a real file, and cancel-handling is
 * where import/export code tends to forget a null check.
 */
import { recordNative } from "../state";

export interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  [key: string]: unknown;
}

export async function open(options?: OpenDialogOptions): Promise<string | string[] | null> {
  recordNative(`dialog.open(${JSON.stringify(options ?? {})})`);
  return options?.multiple ? [] : null;
}

export async function save(): Promise<string | null> {
  recordNative("dialog.save()");
  return null;
}

export async function message(text: string): Promise<void> {
  recordNative(`dialog.message(${text})`);
}

export async function ask(): Promise<boolean> {
  return false;
}

export async function confirm(): Promise<boolean> {
  return false;
}
