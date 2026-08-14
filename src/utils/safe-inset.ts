/**
 * The safe-area insets in CSS pixels, for the few places that position
 * something with JavaScript and so cannot reach `--spacing-safe-bottom` /
 * `--spacing-safe-top` from a stylesheet.
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
const cached: { bottom: number | null; top: number | null } = { bottom: null, top: null };

if (typeof window !== "undefined") {
  const invalidate = () => {
    cached.bottom = null;
    cached.top = null;
  };
  window.addEventListener("resize", invalidate);
  window.addEventListener("orientationchange", invalidate);
}

/** `null` before there is a body to hang the probe on — nothing to cache yet. */
function measure(token: string): number | null {
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "left:0",
    "bottom:0",
    "width:0",
    `height:var(${token})`,
    "pointer-events:none",
    "visibility:hidden",
  ].join(";");
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

export function readSafeInsetBottom(): number {
  cached.bottom ??= measure("--spacing-safe-bottom");
  return cached.bottom ?? 0;
}

export function readSafeInsetTop(): number {
  cached.top ??= measure("--spacing-safe-top");
  return cached.top ?? 0;
}
