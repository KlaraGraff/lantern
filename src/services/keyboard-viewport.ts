/**
 * Keeps the app's shell the size of what the user can actually see, so the
 * software keyboard shrinks the layout instead of scrolling the whole app off
 * the screen.
 *
 * The desktop build gives every route an `h-screen` shell and
 * [`index.css`](../index.css) reasons from that: "the document scroller has
 * nothing to scroll on any screen". That is true right up until iOS raises the
 * keyboard, and the failure is a two-step one that is easy to get half right.
 *
 * Step one is the shell. Measured in the AI panel on the Simulator: with the
 * keys up, `visualViewport.height` and `window.innerHeight` both read 570 where
 * they had read 956. Measured in Settings on the same build, though,
 * `visualViewport.height` read 543 while `window.innerHeight` stayed at 956 —
 * the layout viewport shrinks in this WKWebView sometimes and not others, so
 * `100dvh` is not dependable and neither is any arithmetic on `innerHeight`.
 * `--app-viewport-height` reports `visualViewport.height`, which was right in
 * both. With no keyboard up the value equals the layout viewport, so the
 * override is its own no-op and there is no state to get out of sync.
 *
 * Step two is the scroll, and this is the half that actually broke. Before it
 * resizes anything, WebKit scrolls the document to bring the focused field into
 * the shrinking window — 386pt in the same measurement. Then the shell shrinks
 * to 570 under it, the document has no scrollable range left at all, and WebKit
 * *does not clamp the offset back*. A 570pt shell viewed from 386pt down shows
 * its bottom 184pt and nothing else: the reader's title band, the panel header
 * and the whole message list sit above the top edge, and only the input bar
 * survives. Scrolling back by hand trades one loss for the other. So the scroll
 * offset is put back to 0 by hand, and that — not the height — is what returns
 * the header. Every text field in the app sits behind this.
 *
 * Putting the document scroller back to 0 takes away the only reveal WebKit
 * performed, so the field has to be revealed again from the right scroller.
 * Once the shell is the size of the window, the document has no scrollable
 * range at all and the field's own container — the settings list, the notes
 * list — is the one that can move. `scrollIntoView({ block: "nearest" })` picks
 * it and is a no-op for a field that is already in view, which covers the input
 * bars that sit in no scroller at all. Note that this only works once the
 * scroller has an edge to work against: a `fixed inset-0` overlay is sized off
 * the layout viewport, so in Settings the modal stayed 956 tall behind a 543pt
 * window, its scrollport ran on behind the keys, and `nearest` correctly
 * concluded the field was already in view while the user could not see it.
 * `index.css` caps those overlays for exactly this reason.
 *
 * The keyboard is detected by *focus*, not by measuring. The obvious test —
 * `innerHeight - visualViewport.height` — is 0 in the reader and 413 in
 * Settings for one and the same keyboard, so it reads "no keyboard" on exactly
 * the fields that need the fix. Whether a text field holds focus is the thing
 * being asked about anyway.
 *
 * `--spacing-keyboard-inset` is that same unreliable difference, which is the
 * right number for the one job it has: `position: fixed` resolves against the
 * layout viewport, so a sheet pinned to `bottom-0` needs to be lifted by
 * however much of that viewport the keys cover — 0 where the viewport already
 * shrank, 413 where it did not. The sheets that pay it stay correct either way.
 *
 * Two things this deliberately does *not* do:
 *
 * - It stands down while the page is pinch-zoomed. `visualViewport.height`
 *   shrinks for zoom exactly as it does for a keyboard, and pinning the scroller
 *   to 0 would fight the reader's own fingers. Scale is only ever above 1 when
 *   nothing is focused, because `focus-zoom-guard` clamps it the moment a field
 *   is touched.
 * - It corrects `scrollY` only while a field holds focus. The document scroller
 *   is unused on every route, but pinning it at all times would be a jitter
 *   generator for no gain.
 *
 * Coarse pointers only, the same rule as everything else here: a macOS window
 * dragged to phone width has a fine pointer and never sees any of it.
 */

/** `visualViewport.scale` is a float; 1 rarely arrives as exactly 1. */
const SCALE_EPSILON = 0.01;

/** The elements that raise a keyboard. `<select>` raises a picker, not keys. */
function isTextEntry(el: Element | null): boolean {
  if (el == null) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
}

export function installKeyboardViewport(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia?.("(pointer: coarse)").matches !== true) return;
  const viewport = window.visualViewport;
  if (!viewport) return;

  const root = document.documentElement;
  let frame: number | undefined;
  /** The field to keep in view, from `focusin` until the matching `focusout`. */
  let reveal: HTMLElement | null = null;

  const apply = () => {
    frame = undefined;

    if (viewport.scale > 1 + SCALE_EPSILON) {
      // Pinch-zoomed. Hand the shells back to `100dvh` and let the browser's
      // own zoom behaviour have the page.
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--spacing-keyboard-inset");
      root.style.removeProperty("--spacing-safe-bottom");
      return;
    }

    const typing = isTextEntry(document.activeElement);
    const height = Math.round(viewport.height);
    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height));

    root.style.setProperty("--app-viewport-height", `${height}px`);
    root.style.setProperty("--spacing-keyboard-inset", `${covered}px`);
    // The home indicator is behind the keyboard; reserving 34pt above the keys
    // is a gap, not a margin.
    if (typing) root.style.setProperty("--spacing-safe-bottom", "0px");
    else root.style.removeProperty("--spacing-safe-bottom");

    // Half the fix. See the note at the top: WebKit scrolled to reveal the
    // field and never clamps it back once the shell no longer overflows.
    if (typing && window.scrollY !== 0) window.scrollTo(0, 0);

    // The other half — put the field back in view from its own scroller. Run
    // on every pass while it holds focus rather than once: the keyboard
    // animates, so the pass that first sees the shorter shell is not
    // necessarily the last one, and `nearest` is idempotent.
    if (typing && reveal != null && document.activeElement === reveal) {
      reveal.scrollIntoView({ block: "nearest" });
    }
  };

  const schedule = () => {
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(apply);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  // Rotation resizes the layout viewport, which `visualViewport` reports a beat
  // later and sometimes mid-transition; a second pass on the window's own event
  // costs nothing and settles the stale value.
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("resize", schedule);
  // `apply` reads `document.activeElement`, so it has to run when focus moves
  // and not only when the viewport does. Blur is the one that matters most:
  // the keyboard leaves without necessarily moving the scroller again.
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    reveal = target instanceof HTMLElement && isTextEntry(target) ? target : null;
    schedule();
  });
  document.addEventListener("focusout", () => {
    reveal = null;
    schedule();
  });

  apply();
}
