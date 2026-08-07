/**
 * Throttle-proof scheduling primitives.
 *
 * A browser-automation session normally leaves the page *hidden*, and Chrome
 * then clamps `setTimeout` to roughly 1Hz and stops `requestAnimationFrame`
 * altogether. Anything built on small timers — the invoke mock's "resolve on
 * the next tick", the sweep's settle loop — runs 50× slower there and looks
 * wedged rather than slow.
 *
 * `MessageChannel` tasks are not throttled, so everything that needs "soon"
 * goes through here instead.
 */

const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const pending: Array<() => void> = [];

if (channel) {
  channel.port1.onmessage = () => pending.shift()?.();
  channel.port1.start?.();
}

/** Resolve on the next macrotask, at full speed even in a hidden tab. */
export function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!channel) {
      setTimeout(resolve, 0);
      return;
    }
    pending.push(resolve);
    channel.port2.postMessage(0);
  });
}

/** Wall-clock wait that survives timer throttling. */
export async function sleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await macrotask();
}
