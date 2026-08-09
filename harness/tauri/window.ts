/**
 * Mock of `@tauri-apps/api/window`. The alias exists so an import added later
 * fails visibly at the mock rather than pulling the real IPC package into the
 * harness bundle — and a missing export here is a boot failure, not a silent
 * one: ES modules refuse the whole module, so the app never renders at all.
 * Anything `src/` imports from this path needs a line below it.
 */
export { WebviewWindow as Window, getCurrentWebviewWindow as getCurrentWindow, getAllWebviewWindows as getAllWindows } from "./webviewWindow";

export const currentMonitor = async () => null;
export const primaryMonitor = async () => null;
export const availableMonitors = async () => [];
/**
 * No monitors in the harness, so no monitor contains the point. Reader window
 * placement falls back to its no-monitor path, which is the branch a browser
 * run can exercise anyway.
 */
export const monitorFromPoint = async () => null;
export const UserAttentionType = { Critical: 1, Informational: 2 } as const;
