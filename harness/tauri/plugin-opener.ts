/**
 * Mock of `@tauri-apps/plugin-opener`.
 *
 * Records the request and resolves. Actually opening a tab mid-sweep would
 * steal focus and could navigate the harness away from the page under test.
 */
import { recordNative } from "../state";

export async function openUrl(url: string, openWith?: string): Promise<void> {
  void openWith;
  recordNative(`openUrl(${url})`);
  console.info(`[harness] openUrl suppressed: ${url}`);
}

export async function openPath(path: string): Promise<void> {
  recordNative(`openPath(${path})`);
}

export async function revealItemInDir(path: string): Promise<void> {
  recordNative(`revealItemInDir(${path})`);
}
