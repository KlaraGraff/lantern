/**
 * Harness bootstrap. `vite.config.harness.ts` injects this as a module script
 * *ahead of* `/src/main.tsx`, and module scripts execute in document order, so
 * everything here runs before a single line of app code — which is the only way
 * to catch a throw at app module top-level or in the first render.
 *
 * Nothing in `src/` knows this file exists.
 */
import { installCollectors } from "./collectors";
import { harness } from "./state";

installCollectors();

console.info("[harness] collectors installed; Tauri APIs are mocked");

const params = new URLSearchParams(window.location.search);

if (params.get("smoke") === "1") {
  // Load the sweep lazily so a plain harness run (no `?smoke=1`) does not pay
  // for it, and start it only once the app has had its first paint.
  window.addEventListener("load", () => {
    void import("./smoke")
      .then(({ runSmoke }) => runSmoke())
      .catch((error: unknown) => {
        // `__smoke_restart__` is the sweep unwinding itself before a deliberate
        // reload — not a failure, and it must not surface as an unhandled
        // rejection the collectors would then report as an app bug.
        const message = error instanceof Error ? error.message : String(error);
        if (message === "__smoke_restart__" || message === "__smoke_give_up__") return;
        console.error("[harness] smoke runner crashed", error);
      });
  });
}

// Convenience for a human driving the harness by hand from devtools.
Object.defineProperty(window, "__harnessCalls", {
  get: () => harness.calls.map((c) => c.command),
  configurable: true,
});
