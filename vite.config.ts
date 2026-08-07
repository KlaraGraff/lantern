import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const lowerReactMarkdownObjectHasOwn = (): Plugin => ({
  name: "lower-react-markdown-object-has-own",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/node_modules/react-markdown/")) return null;
    const transformed = code.replaceAll(
      "Object.hasOwn(",
      "Object.prototype.hasOwnProperty.call(",
    );
    return transformed === code ? null : { code: transformed, map: null };
  },
});

// `mdast-util-gfm-autolink-literal` guards its bare-email pattern with a
// lookbehind, which WebKit only understands from Safari 16.4. esbuild lowers
// the literal to a `new RegExp` call so the bundle still parses, and then it
// throws on macOS 12 the first time an AI answer is rendered — taking the chat
// down with it. The guard only rejects an email glued to the right of a
// non-ASCII letter, so dropping it links marginally more than upstream does
// rather than less; the match extents, which `findAndReplace` slices by, are
// untouched.
const dropGfmAutolinkLookbehind = (): Plugin => ({
  name: "drop-gfm-autolink-lookbehind",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/node_modules/mdast-util-gfm-autolink-literal/")) return null;
    const transformed = code.replaceAll(
      "/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@",
      "/([-.\\w+]+)@",
    );
    return transformed === code ? null : { code: transformed, map: null };
  },
});

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    lowerReactMarkdownObjectHasOwn(),
    dropGfmAutolinkLookbehind(),
    react(),
    tailwindcss(),
  ],

  build: {
    target: "safari15",
    cssTarget: "safari15",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
