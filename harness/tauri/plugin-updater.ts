/**
 * Mock of `@tauri-apps/plugin-updater`.
 *
 * `check()` resolves to `null` — up to date. The update toast's "there is an
 * update" branch needs a live endpoint to be honest about, so the harness takes
 * the branch it can model truthfully rather than faking a download.
 */
export interface Update {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: unknown) => void): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export async function check(): Promise<Update | null> {
  return null;
}
