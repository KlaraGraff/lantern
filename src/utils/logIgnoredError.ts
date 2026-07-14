import { invoke } from "@tauri-apps/api/core";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Use for deliberate degraded behavior; unexpected failures should be handled by the caller. */
export function logIgnoredError(scope: string, error: unknown): void {
  const message = errorMessage(error);
  if (import.meta.env.DEV) console.warn(`Quill fallback [${scope}]`, error);
  void invoke("log_webview_warning", { scope, message }).catch((logError) => {
    if (import.meta.env.DEV) console.warn("Could not record Quill fallback", logError);
  });
}
