/**
 * Where a book opens (docs/impls/ui-redesign-single-window.md). The reader is
 * a route in the window you are in; a window of its own is something you ask
 * for. No Tauri imports, so `tests/reader-open-mode.test.ts` drives it directly.
 */

export interface OpenModeContext {
  /** `platform.hasWindow`: more than one OS window can exist here. */
  hasWindow: boolean;
  /** This webview is a reader window of its own (`reader-<id>`), not the library window. */
  inStandaloneReader: boolean;
}

/**
 * A new OS window only where one can exist, and only when asked for — or when
 * the request comes from a standalone reader window, which cannot swap its
 * book for another without losing the one it was opened for.
 */
export function opensInNewWindow({ hasWindow, inStandaloneReader }: OpenModeContext, newWindow?: boolean): boolean {
  if (!hasWindow) return false;
  return newWindow === true || inStandaloneReader;
}

/** ⌘-click on a Mac, Ctrl-click elsewhere: the platform's own "open in a new window" gesture. */
export function wantsNewWindow(event: { metaKey: boolean; ctrlKey: boolean }, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
