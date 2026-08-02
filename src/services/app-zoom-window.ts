import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { APP_ZOOM_STORAGE_KEY, DEFAULT_APP_ZOOM, parseAppZoom } from "./app-zoom";

/** One zoom for the whole app, so a change has to reach the other window. */
const APP_ZOOM_CHANGED_EVENT = "app-zoom-changed";

export function readAppZoom(): number {
  try {
    return parseAppZoom(localStorage.getItem(APP_ZOOM_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_ZOOM;
  }
}

/**
 * Zoom through the webview rather than through a CSS transform, so the engine
 * handles everything a transform would quietly break: viewport units, media
 * queries, hit testing, and the book's own iframe.
 *
 * `--app-zoom` carries the same factor into CSS for one purpose — the macOS
 * titlebar reserve divides it back out. The traffic lights are drawn by the
 * system at a fixed size and do not zoom with the page, so the strip that makes
 * room for them has to stay the same number of screen pixels at every scale.
 */
export function applyAppZoom(percent: number): void {
  const factor = percent / 100;
  document.documentElement.style.setProperty("--app-zoom", String(factor));
  try {
    getCurrentWebview().setZoom(factor).catch(() => {});
  } catch {
    // Reached before the webview handle exists, or outside Tauri entirely.
    // This runs before React mounts, so a throw here would cost the whole app.
  }
}

/** Apply it here, remember it, and tell the other windows. */
export function persistAppZoom(percent: number): void {
  applyAppZoom(percent);
  try {
    localStorage.setItem(APP_ZOOM_STORAGE_KEY, String(percent));
  } catch {
    // A store that refuses writes costs the setting its memory, not its effect.
  }
  emit(APP_ZOOM_CHANGED_EVENT, { percent }).catch(() => {});
}

/**
 * The emitting window hears its own event, which re-applies a factor it already
 * has — idempotent, and cheaper than teaching every window who sent what.
 */
export function listenForAppZoom(handler: (percent: number) => void): Promise<UnlistenFn> {
  return listen<{ percent: number }>(APP_ZOOM_CHANGED_EVENT, (event) => {
    const percent = event.payload?.percent;
    // Ignored rather than defaulted: an event that arrives without a level is
    // no reason to drag the window back to 100%.
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    handler(parseAppZoom(String(percent)));
  });
}
