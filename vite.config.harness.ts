/**
 * Browser smoke-test harness config. Production `vite.config.ts` is untouched;
 * this file reuses it and layers three things on top:
 *
 *  1. `resolve.alias` swaps every `@tauri-apps/*` entrypoint for a mock in
 *     `harness/tauri/`, so the app runs in plain Chrome with no Rust side.
 *  2. `transformIndexHtml` injects `harness/entry.ts` *before* `/src/main.tsx`.
 *     Module scripts execute in document order, so the error collectors are
 *     installed before a single line of app code runs.
 *  3. A dev middleware serves the real EPUB/PDF fixtures out of `tests/` at
 *     `/__harness/book.epub` and `/__harness/book.pdf`, which is what the
 *     `convertFileSrc` mock points book files at. The reader therefore opens a
 *     genuine book through the vendored foliate-js, not a stub.
 *
 * It also derives a command -> return-shape table by scraping `#[tauri::command]`
 * signatures out of the Rust sources at config load, exposed as the virtual
 * module `virtual:harness-rust-shapes`. That is what lets the default `invoke`
 * stub answer 200-odd commands with a plausibly shaped empty value instead of
 * `null` for everything, without anyone hand-writing 186 fixtures.
 *
 * Run with: npm run smoke
 */
import { defineConfig, type Plugin, type UserConfig, type UserConfigFn } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";

import baseConfigExport from "./vite.config";

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = resolvePath(here, "harness");

const mock = (name: string) => resolvePath(harnessDir, "tauri", `${name}.ts`);

/** Every `@tauri-apps` entrypoint the app imports, mapped to its mock. */
const TAURI_ALIASES: Array<[RegExp, string]> = [
  [/^@tauri-apps\/api\/core$/, mock("core")],
  [/^@tauri-apps\/api\/event$/, mock("event")],
  [/^@tauri-apps\/api\/webviewWindow$/, mock("webviewWindow")],
  [/^@tauri-apps\/api\/webview$/, mock("webview")],
  [/^@tauri-apps\/api\/window$/, mock("window")],
  [/^@tauri-apps\/api\/path$/, mock("path")],
  [/^@tauri-apps\/plugin-dialog$/, mock("plugin-dialog")],
  [/^@tauri-apps\/plugin-fs$/, mock("plugin-fs")],
  [/^@tauri-apps\/plugin-opener$/, mock("plugin-opener")],
  [/^@tauri-apps\/plugin-os$/, mock("plugin-os")],
  [/^@tauri-apps\/plugin-process$/, mock("plugin-process")],
  [/^@tauri-apps\/plugin-updater$/, mock("plugin-updater")],
];

/* ------------------------------------------------------------------ *
 * Rust return-shape scrape
 * ------------------------------------------------------------------ */

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) rustFiles(full, out);
    else if (entry.name.endsWith(".rs")) out.push(full);
  }
  return out;
}

/** command name -> raw Rust return type, e.g. `AppResult<Vec<Book>>`. */
function scrapeCommandReturnTypes(): Record<string, string> {
  const root = resolvePath(here, "src-tauri", "src");
  const out: Record<string, string> = {};
  let files: string[];
  try {
    files = rustFiles(root);
  } catch {
    return out; // No Rust tree (shouldn't happen); default stub falls back to null.
  }
  const head = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(/g;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(source))) {
      // Walk to the matching close paren of the argument list, then read `-> T {`.
      let i = m.index + m[0].length - 1;
      let depth = 0;
      for (; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")" && --depth === 0) break;
      }
      const tail = source.slice(i + 1, i + 400);
      const ret = /^\s*->\s*([\s\S]*?)\s*\{/.exec(tail);
      out[m[1]] = ret ? ret[1].replace(/\s+/g, " ").trim() : "()";
    }
  }
  return out;
}

const VIRTUAL_SHAPES = "virtual:harness-rust-shapes";

function harnessPlugin(): Plugin {
  const resolved = "\0" + VIRTUAL_SHAPES;
  return {
    name: "lantern-harness",
    enforce: "pre",

    resolveId(id) {
      if (id === VIRTUAL_SHAPES) return resolved;
      return null;
    },
    load(id) {
      if (id !== resolved) return null;
      return `export default ${JSON.stringify(scrapeCommandReturnTypes())};`;
    },

    // Put the harness entry ahead of /src/main.tsx. Module scripts run in
    // document order, so this is what guarantees "collectors first".
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module", src: "/harness/entry.ts" },
          injectTo: "head-prepend" as const,
        },
      ];
    },

    configureServer(server) {
      const fixtures: Record<string, [string, string]> = {
        "/__harness/book.epub": [
          resolvePath(here, "tests/fixtures/reader-compat/minimal-deflated.epub"),
          "application/epub+zip",
        ],
        "/__harness/book.pdf": [
          resolvePath(here, "tests/fixtures/reader-compat/minimal-text.pdf"),
          "application/pdf",
        ],
      };
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const hit = fixtures[path];
        if (!hit) return next();
        try {
          const [file, mime] = hit;
          res.setHeader("Content-Type", mime);
          res.setHeader("Content-Length", String(statSync(file).size));
          res.setHeader("Access-Control-Allow-Origin", "*");
          createReadStream(file).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end("harness fixture missing");
        }
      });
    },
  };
}

export default defineConfig(async (env) => {
  const base = (await (baseConfigExport as unknown as UserConfigFn)(env)) as UserConfig;

  return {
    ...base,
    plugins: [harnessPlugin(), ...(base.plugins ?? [])],
    resolve: {
      ...base.resolve,
      alias: [
        ...TAURI_ALIASES.map(([find, replacement]) => ({ find, replacement })),
      ],
    },
    // Chrome-only target: no reason to down-level to safari15 here, and the
    // harness deliberately does NOT model WebKit (see harness/README.md).
    esbuild: { target: "es2022" },
    optimizeDeps: {
      ...base.optimizeDeps,
      exclude: ["@tauri-apps/api", ...TAURI_ALIASES.map(() => "").filter(Boolean)],
    },
    clearScreen: false,
    server: {
      ...base.server,
      port: 1440,
      strictPort: false,
      host: false,
      hmr: false as const,
      watch: { ignored: ["**/src-tauri/**"] },
    },
  } satisfies UserConfig;
});
