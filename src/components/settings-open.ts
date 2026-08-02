import { getCurrentWebview } from "@tauri-apps/api/webview";

import { normalizeSettingsDestination, type SettingsDestination } from "./settings-destination";

/**
 * Asking for the settings modal, from anywhere.
 *
 * The modal is mounted once, above the router (`SettingsHost`). Every other
 * surface — the sidebar button, a reader window, the native menu — says "open
 * settings" and holds none of the open/closed state itself.
 */
export const OPEN_SETTINGS_EVENT = "open-settings";

/** Open the modal in this window, optionally on a particular destination. */
export function openSettings(destination: SettingsDestination = "general") {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: destination }));
}

/**
 * Both routes in: a DOM event from this window, and a Tauri event from another
 * one (a reader window, or the backend's `open_settings_on_main`). The Tauri
 * listener has to be webview-specific because the sender addresses the main
 * webview by label.
 *
 * Returns a synchronous teardown so a `useEffect` can return it directly.
 */
export function listenForOpenSettings(
  handler: (destination: SettingsDestination) => void,
): () => void {
  const onDomEvent = (event: Event) => {
    handler(normalizeSettingsDestination((event as CustomEvent).detail));
  };
  window.addEventListener(OPEN_SETTINGS_EVENT, onDomEvent);

  const unlisten = getCurrentWebview().listen<unknown>(OPEN_SETTINGS_EVENT, (event) => {
    handler(normalizeSettingsDestination(event.payload));
  });

  return () => {
    window.removeEventListener(OPEN_SETTINGS_EVENT, onDomEvent);
    void unlisten.then((stop) => stop()).catch(() => {});
  };
}
