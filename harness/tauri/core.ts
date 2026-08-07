/**
 * Mock of `@tauri-apps/api/core`.
 *
 * `invoke` resolves in three steps:
 *   1. a hand-written fixture (`invoke-fixtures.ts`), for the ~40 commands that
 *      gate rendering;
 *   2. a deliberate rejection, for the handful that would need a live network
 *      (AI, speech, dictionary) — recorded separately so the sweep never counts
 *      them as app bugs;
 *   3. otherwise a *shape-guessed* stub derived from the Rust return type, and
 *      the command name is logged once as `[harness] unstubbed command: <name>`.
 *
 * Step 3 is the important one: an unstubbed command is a gap in the harness,
 * never a failure of the app. The sweep report keeps the two apart.
 */
import { hasFixture, resolveFixture, DELIBERATE_REJECTIONS } from "../invoke-fixtures";
import { stubValueFor } from "../shape-defaults";
import { harness, recordCall } from "../state";
import { macrotask } from "../task";

export type InvokeArgs = Record<string, unknown>;

/**
 * Resolves on the next macrotask, so the app's loading states get a turn — but
 * via `MessageChannel`, not `setTimeout`: a hidden tab clamps timers to ~1Hz,
 * which would make every single IPC call in the app take a second.
 */
export function invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
  const callArgs = args ?? {};
  recordCall(command, callArgs);

  return new Promise<T>((resolve, reject) => {
    void macrotask().then(() => {
      const deliberate = DELIBERATE_REJECTIONS[command];
      if (deliberate) {
        harness.rejected.add(command);
        reject(new Error(deliberate));
        return;
      }
      if (hasFixture(command)) {
        try {
          resolve(resolveFixture(command, callArgs) as T);
        } catch (error) {
          // A throwing fixture is a harness bug; surface it loudly but tagged.
          console.error(`[harness] fixture for "${command}" threw`, error);
          reject(error);
        }
        return;
      }
      if (!harness.unstubbed.has(command)) {
        harness.unstubbed.add(command);
        console.info(`[harness] unstubbed command: ${command}`);
      }
      harness.stubsSinceMark.push(command);
      resolve(stubValueFor(command) as T);
    });
  });
}

/**
 * Book files map onto the two real fixtures the harness Vite middleware serves,
 * so the reader opens a genuine EPUB/PDF through foliate-js. Anything else
 * (covers, fonts) becomes a harmless same-origin URL.
 */
export function convertFileSrc(filePath: string, _protocol?: string): string {
  void _protocol;
  const lower = (filePath ?? "").toLowerCase();
  if (lower.endsWith(".pdf")) return "/__harness/book.pdf";
  if (/\.(epub|mobi|azw3?|fb2|fbz|cbz)$/.test(lower)) return "/__harness/book.epub";
  return `/__harness/file?path=${encodeURIComponent(filePath ?? "")}`;
}

export const isTauri = true;

/** Tauri's own error wrapper; a couple of call sites `instanceof` it. */
export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
  id = 0;
  toJSON() {
    return `__CHANNEL__:${this.id}`;
  }
}

export class Resource {
  readonly rid: number = 0;
  async close(): Promise<void> {}
}

export function transformCallback(callback?: (response: unknown) => void): number {
  void callback;
  return 0;
}

export async function addPluginListener(): Promise<{ unregister: () => Promise<void> }> {
  return { unregister: async () => {} };
}

export const PermissionState = {} as const;
