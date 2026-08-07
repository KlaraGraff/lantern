/**
 * Mock of `@tauri-apps/api/path`. Same rationale as `window.ts`: unused today,
 * aliased so it cannot quietly become a real dependency.
 */
export const sep = () => "/";
export const delimiter = () => ":";
export async function appDataDir(): Promise<string> { return "/harness/appdata"; }
export async function appConfigDir(): Promise<string> { return "/harness/config"; }
export async function appLocalDataDir(): Promise<string> { return "/harness/localdata"; }
export async function appCacheDir(): Promise<string> { return "/harness/cache"; }
export async function appLogDir(): Promise<string> { return "/harness/logs"; }
export async function documentDir(): Promise<string> { return "/harness/documents"; }
export async function downloadDir(): Promise<string> { return "/harness/downloads"; }
export async function homeDir(): Promise<string> { return "/harness"; }
export async function tempDir(): Promise<string> { return "/harness/tmp"; }
export async function join(...parts: string[]): Promise<string> { return parts.join("/"); }
export async function resolve(...parts: string[]): Promise<string> { return parts.join("/"); }
export async function dirname(path: string): Promise<string> { return path.split("/").slice(0, -1).join("/"); }
export async function basename(path: string): Promise<string> { return path.split("/").pop() ?? ""; }
export async function extname(path: string): Promise<string> { return path.split(".").pop() ?? ""; }
