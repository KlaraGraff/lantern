/**
 * Loader for the Foliate modules the app needs to call directly (the footnote
 * handler and the CFI helpers).
 *
 * These live in `/public/foliate-js`, which Vite serves as-is and never
 * transforms, so a dynamic `import()` from app source fails on the dev server:
 * Vite rewrites a non-literal specifier into a `?import` request and then
 * refuses it. The CSP (`script-src 'self'`) blocks the usual workarounds, so
 * the modules come in through a same-origin module script — the same path
 * `view.js` already takes — which re-exports them on `globalThis`. See
 * `public/foliate-js/lantern-modules.js`.
 */

/** Minimal shape of `epubcfi.js` — the parts app code actually calls. */
export interface CfiModule {
  parse(cfi: string): unknown;
  collapse(cfi: string, toEnd?: boolean): string;
  compare(left: string, right: string): number;
}

export interface FoliateModules {
  FootnoteHandler: new () => unknown;
  epubcfi: CfiModule;
}

const BRIDGE_URL = "/foliate-js/lantern-modules.js";
const GLOBAL_KEY = "__lanternFoliateModules";

let modulesPromise: Promise<FoliateModules> | null = null;

function readBridgeGlobal(): FoliateModules | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as FoliateModules | undefined;
}

export function loadFoliateModules(): Promise<FoliateModules> {
  modulesPromise ??= new Promise<FoliateModules>((resolve, reject) => {
    const alreadyLoaded = readBridgeGlobal();
    if (alreadyLoaded) {
      resolve(alreadyLoaded);
      return;
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = BRIDGE_URL;
    script.onload = () => {
      // A module script's load event fires after it has executed, so the
      // bridge's assignment has already happened by now.
      const loaded = readBridgeGlobal();
      if (loaded) resolve(loaded);
      else reject(new Error("foliate-js module bridge loaded without exporting"));
    };
    script.onerror = () => reject(new Error("Failed to load the foliate-js module bridge"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // Let a later attempt retry rather than caching the rejection forever.
    modulesPromise = null;
    throw error;
  });
  return modulesPromise;
}
