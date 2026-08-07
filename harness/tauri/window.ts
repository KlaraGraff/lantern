/**
 * Mock of `@tauri-apps/api/window`. Nothing in `src/` imports it today; the
 * alias exists so an import added later fails visibly at the mock rather than
 * pulling the real IPC package into the harness bundle.
 */
export { WebviewWindow as Window, getCurrentWebviewWindow as getCurrentWindow, getAllWebviewWindows as getAllWindows } from "./webviewWindow";

export const currentMonitor = async () => null;
export const primaryMonitor = async () => null;
export const availableMonitors = async () => [];
export const UserAttentionType = { Critical: 1, Informational: 2 } as const;
