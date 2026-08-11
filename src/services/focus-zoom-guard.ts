/**
 * Stops WKWebView from zooming the whole app in when a text field takes focus.
 *
 * The reflex fix for this is `maximum-scale=1` in the viewport meta, and
 * [the responsive foundation](../../docs/impls/responsive-foundation.md#what-was-deliberately-not-done)
 * rejected it on the grounds that WKWebView honours it and a reading app is the
 * worst possible app to take pinch-zoom away from. That reasoning still holds —
 * what has changed is the measurement. The other half of that note assumed the
 * 16px font floor was the whole story, because in mobile Safari it is. It is not
 * in WKWebView: measured on the Simulator (iPhone 17, 402pt), opening
 * Settings → Personal with the profile textarea at a computed 16px still zoomed
 * the page to ~1.22× and scrolled it ~37px right, which put the back chevron off
 * the left edge with no way back — the page never zooms out on blur. WebKit is
 * fitting the *focused element's box* to the viewport width, not judging its
 * font size, so a font floor cannot reach it. 1.22 is 402/329, and 329pt is the
 * editor card's width; the numbers line up exactly.
 *
 * So the flag goes on, but only for as long as something is focused. Pinch-zoom
 * is available whenever the reader is actually reading, which is when they would
 * reach for it, and the clamp exists only during the moments they are typing.
 * Reinstating the base value on blur also doubles as the escape hatch the
 * original bug lacked: whatever scale the page is stuck at, dropping back to a
 * `maximum-scale=1` viewport clamps it to 1 again.
 *
 * `pointerdown` clamps as well as `focusin` on purpose. The zoom is decided in
 * the UI process once it hears about the focused element, and the meta change is
 * a separate message; clamping on the touch that is about to cause the focus
 * takes the ordering question off the table.
 *
 * Coarse pointers only — same rule as everything else here: interaction follows
 * input type, never viewport width. A macOS window dragged to phone width has a
 * fine pointer, never sees this, and keeps its zoom untouched.
 */

const CLAMP = "maximum-scale=1";
/** Long enough to survive tabbing between two fields, short enough to be invisible. */
const RELEASE_DELAY_MS = 250;

let meta: HTMLMetaElement | null = null;
let base = "";
let clamped = false;
let releaseTimer: number | undefined;

function isTextEntry(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === "TEXTAREA" || node.tagName === "SELECT") return true;
  if (node.tagName !== "INPUT") return false;
  // The same exclusions as the 16px floor in `index.css`, plus the input types
  // that open a native picker rather than a keyboard. None of them has text to
  // zoom toward.
  const type = (node as HTMLInputElement).type;
  return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"].includes(type);
}

function clamp(): void {
  if (releaseTimer !== undefined) {
    window.clearTimeout(releaseTimer);
    releaseTimer = undefined;
  }
  if (clamped || !meta) return;
  meta.content = base.length > 0 ? `${base}, ${CLAMP}` : CLAMP;
  clamped = true;
}

function release(): void {
  if (!clamped || !meta) return;
  meta.content = base;
  clamped = false;
}

export function installFocusZoomGuard(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia?.("(pointer: coarse)").matches !== true) return;
  meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  base = meta.content;

  document.addEventListener("pointerdown", (event) => {
    if (isTextEntry(event.target)) clamp();
  }, true);
  document.addEventListener("focusin", (event) => {
    if (isTextEntry(event.target)) clamp();
  }, true);
  document.addEventListener("focusout", () => {
    if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      releaseTimer = undefined;
      // Re-read rather than trust the blur: focus may well have landed on
      // another field, and flapping the meta between two keystrokes is a
      // visible jolt.
      if (!isTextEntry(document.activeElement)) release();
    }, RELEASE_DELAY_MS);
  }, true);
}
