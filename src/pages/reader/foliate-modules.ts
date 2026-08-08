/**
 * Loader for the Foliate modules the app needs to call directly (the footnote
 * handler, the CFI helpers, and the text walker).
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

/**
 * Builds a Range from indices into the array the walker handed out. `strs[i]`
 * is the text of the i-th node, so `(0, 3, 1, 5)` starts three characters into
 * the first node and ends five into the second.
 */
export type MakeRange = (
  startIndex: number,
  startOffset: number,
  endIndex: number,
  endOffset: number,
) => Range;

/**
 * Walks a document's text nodes and hands the whole run to `visit` at once,
 * yielding whatever `visit` yields.
 *
 * The flattened array plus `makeRange` is what makes cross-node matching
 * possible: a sentence broken across an `<em>` is one string here, and the
 * character offsets found in it map straight back to a real Range.
 */
export type TextWalker = <T>(
  target: Document | Range | Element,
  visit: (strs: string[], makeRange: MakeRange) => Iterable<T>,
) => Generator<T>;

export interface FoliateModules {
  FootnoteHandler: new () => unknown;
  epubcfi: CfiModule;
  textWalker: TextWalker;
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
