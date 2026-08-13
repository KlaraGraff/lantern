/**
 * The bottom safe-area inset in CSS pixels, for the few places that position
 * something with JavaScript and so cannot reach `--spacing-safe-bottom` from a
 * stylesheet.
 *
 * Measured with a probe element rather than read off `getComputedStyle`: the
 * custom property's value is the literal `env(safe-area-inset-bottom, 0px)`,
 * and engines hand that token stream back unresolved. Giving a real element a
 * height of it and reading the height back makes the engine resolve it, which
 * is the only portable way to get the number.
 *
 * Cached, because the callers run inside layout effects and a probe forces a
 * reflow. The inset only changes when the viewport does — a rotation, a split
 * view, a window resize — so those events drop the cache.
 */
let cached: number | null = null;

if (typeof window !== "undefined") {
  const invalidate = () => { cached = null; };
  window.addEventListener("resize", invalidate);
  window.addEventListener("orientationchange", invalidate);
}

export function readSafeInsetBottom(): number {
  if (cached !== null) return cached;
  if (typeof document === "undefined" || !document.body) return 0;
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "left:0",
    "bottom:0",
    "width:0",
    "height:var(--spacing-safe-bottom)",
    "pointer-events:none",
    "visibility:hidden",
  ].join(";");
  document.body.appendChild(probe);
  cached = probe.getBoundingClientRect().height;
  probe.remove();
  return cached;
}
