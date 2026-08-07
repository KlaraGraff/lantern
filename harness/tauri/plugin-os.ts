/**
 * Mock of `@tauri-apps/plugin-os`.
 *
 * Answers `macos`, deliberately: `src/services/platform.ts` turns this into the
 * capability set, and macOS is the widest one (windows, drag-drop, OCR, MCP,
 * updater, embedding index). Reporting `ios` would hide most of the app from
 * the sweep. Override with `?platform=ios` on the URL to sweep the mobile
 * capability set instead.
 */
type PlatformId = "macos" | "windows" | "linux" | "ios" | "android";

const ALLOWED: PlatformId[] = ["macos", "windows", "linux", "ios", "android"];

function requested(): PlatformId {
  try {
    const value = new URLSearchParams(window.location.search).get("platform");
    if (value && (ALLOWED as string[]).includes(value)) return value as PlatformId;
  } catch {
    // No URL (unit-test import); fall through.
  }
  return "macos";
}

export function platform(): PlatformId {
  return requested();
}

export function arch(): string {
  return "aarch64";
}

export function type(): string {
  return "macos";
}

export function version(): string {
  return "15.0.0";
}

export function family(): string {
  return "unix";
}

export function locale(): Promise<string | null> {
  return Promise.resolve(navigator.language ?? "en-US");
}

export function hostname(): Promise<string | null> {
  return Promise.resolve("harness.local");
}

export function exeExtension(): string {
  return "";
}

export const EOL = "\n";
