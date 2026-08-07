/** Mock of `@tauri-apps/plugin-process`. Never actually restarts the harness. */
import { recordNative } from "../state";

export async function relaunch(): Promise<void> {
  recordNative("process.relaunch()");
  console.info("[harness] relaunch suppressed");
}

export async function exit(code?: number): Promise<void> {
  recordNative(`process.exit(${code ?? 0})`);
  console.info("[harness] exit suppressed");
}
