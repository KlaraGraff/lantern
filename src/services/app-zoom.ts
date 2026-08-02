/**
 * Whole-window zoom — the browser's ⌘= / ⌘- / ⌘0, pointed at the app's own
 * chrome instead of at a book.
 *
 * Everything in this file is pure, so the step ladder and the shortcut rules
 * can be tested without a webview. The parts that touch one live in
 * `app-zoom-window.ts`.
 */

/**
 * Browser-style stops rather than a fixed percentage step. Ten percent is a
 * visible change at 80% and an invisible one at 200%, so the gaps widen with
 * the scale and every press lands somewhere the eye can see.
 */
export const APP_ZOOM_STEPS = [80, 90, 100, 110, 125, 150, 175, 200];
export const DEFAULT_APP_ZOOM = 100;
export const APP_ZOOM_STORAGE_KEY = "lantern-app-zoom";

const MIN_APP_ZOOM = APP_ZOOM_STEPS[0];
const MAX_APP_ZOOM = APP_ZOOM_STEPS[APP_ZOOM_STEPS.length - 1];

export type AppZoomCommand = "in" | "out" | "reset";

/** Only the fields the rule reads, so a test can pass a plain object. */
interface ZoomKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}

/**
 * Which zoom a keystroke asks for, or `null` when it asks for something else.
 *
 * Shift is not consulted: on most layouts `+` *is* shifted `=`, and a user who
 * presses ⌘⇧+ means the same thing as ⌘=. Alt is, because ⌥ turns a shortcut
 * into a different one rather than a louder version of the same one.
 */
export function appZoomCommandFor(event: ZoomKeyEvent): AppZoomCommand | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.altKey) return null;
  switch (event.key) {
    case "=":
    case "+":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

function clampAppZoom(value: number): number {
  return Math.min(MAX_APP_ZOOM, Math.max(MIN_APP_ZOOM, value));
}

/**
 * The stop one press away from `current`.
 *
 * Searched rather than indexed: a value that has drifted off the ladder — an
 * older build's range, a hand-edited key — still moves one stop instead of
 * refusing to move at all.
 */
export function nextAppZoom(current: number, command: AppZoomCommand): number {
  if (command === "reset") return DEFAULT_APP_ZOOM;
  const from = clampAppZoom(current);
  if (command === "in") {
    return APP_ZOOM_STEPS.find((step) => step > from) ?? MAX_APP_ZOOM;
  }
  let below = MIN_APP_ZOOM;
  for (const step of APP_ZOOM_STEPS) {
    if (step < from) below = step;
  }
  return below;
}

/**
 * Read a stored percentage back, falling back to 100% for anything unusable.
 * Out-of-range numbers are clamped rather than rejected: a value written by a
 * build with a wider ladder should land at the nearest edge, not throw the
 * user's preference away.
 */
export function parseAppZoom(raw: string | null | undefined): number {
  const value = Number(raw);
  // `Number(null)` is 0 and `Number("")` is 0 — neither is a zoom level, and
  // both fall through to the default with NaN.
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_APP_ZOOM;
  return clampAppZoom(Math.round(value));
}

/**
 * A PDF makes ⌘= mean "render the page larger", which is a more useful answer
 * than scaling the window around it. The reader claims the shortcuts while such
 * a book is open and the app-wide handler stands aside.
 *
 * Counted rather than flagged: React can mount the next reader before it
 * unmounts the last one, and a flag would be left off by the late cleanup.
 */
let shortcutClaims = 0;

export function claimZoomShortcuts(): () => void {
  shortcutClaims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    shortcutClaims -= 1;
  };
}

export function zoomShortcutsClaimed(): boolean {
  return shortcutClaims > 0;
}
