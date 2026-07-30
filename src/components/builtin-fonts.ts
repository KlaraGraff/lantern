/**
 * Reading fonts we ship with the app.
 *
 * All of these are SIL Open Font License 1.1, which permits bundling and
 * redistribution inside an application. The license texts live next to the
 * font files in `public/fonts/licenses/` and are part of the built bundle —
 * shipping them is an OFL requirement, not a courtesy.
 *
 * The files are the latin and latin-ext subsets Google Fonts serves. Most are
 * variable fonts, so a single file per style covers the whole 400-700 range;
 * Spectral and Atkinson Hyperlegible are static and need one file per weight.
 * See `public/fonts/README.md` for how they were fetched.
 */

/** Shared across every family Google Fonts subsets — verified identical for all ten. */
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, "
  + "U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, "
  + "U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, "
  + "U+2C60-2C7F, U+A720-A7FF";

const SUBSETS = [
  { name: "latin", range: LATIN },
  { name: "latin-ext", range: LATIN_EXT },
] as const;

export interface BuiltinFont {
  /** Reader font id, persisted in settings. */
  id: string;
  /** Menu label and CSS family name. */
  label: string;
  /** Fallback chain appended after the family name. */
  fallback: string;
  /** File-name stem under `public/fonts/`. */
  slug: string;
  /** Variable fonts ship one file per style covering weights 400-700. */
  variable: boolean;
  /** Whether a real italic exists; otherwise the engine obliques it. */
  italic: boolean;
}

const SERIF_FALLBACK = "Georgia, serif";
const SANS_FALLBACK = "system-ui, sans-serif";

export const builtinFonts: BuiltinFont[] = [
  { id: "literata", label: "Literata", slug: "literata", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "libre-baskerville", label: "Libre Baskerville", slug: "libre-baskerville", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "eb-garamond", label: "EB Garamond", slug: "eb-garamond", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "source-serif-4", label: "Source Serif 4", slug: "source-serif-4", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "crimson-pro", label: "Crimson Pro", slug: "crimson-pro", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "newsreader", label: "Newsreader", slug: "newsreader", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "spectral", label: "Spectral", slug: "spectral", variable: false, italic: true, fallback: SERIF_FALLBACK },
  { id: "vollkorn", label: "Vollkorn", slug: "vollkorn", variable: true, italic: true, fallback: SERIF_FALLBACK },
  { id: "atkinson-hyperlegible", label: "Atkinson Hyperlegible", slug: "atkinson-hyperlegible", variable: false, italic: true, fallback: SANS_FALLBACK },
  { id: "lexend", label: "Lexend", slug: "lexend", variable: true, italic: false, fallback: SANS_FALLBACK },
];

/**
 * Foliate renders each chapter in an iframe backed by a blob: URL, where a
 * root-relative path has nothing to resolve against, so these have to be fully
 * absolute.
 *
 * The path is root-relative on purpose. The app routes by path, so by the time
 * a chapter installs its faces the current URL is `/reader/<id>`; a
 * document-relative path would resolve to `/reader/fonts/...` and 404.
 *
 * Resolved against `location.href` rather than `location.origin` because macOS
 * packages serve from `tauri://localhost`, a non-special scheme whose `origin`
 * is the opaque string "null". `href` is a well-formed absolute URL under every
 * scheme Tauri uses, and a leading "/" replaces the path regardless of route.
 */
function fontUrl(file: string): string {
  return new URL(`/fonts/${file}`, window.location.href).href;
}

function face(font: BuiltinFont, style: "normal" | "italic", weight: string, subset: typeof SUBSETS[number]) {
  const file = `${font.slug}-${style}-${weight}-${subset.name}.woff2`;
  return `@font-face { font-family: "${font.label}"; font-style: ${style}; `
    + `font-weight: ${weight.replace("-", " ")}; font-display: swap; `
    + `src: url("${fontUrl(file)}") format("woff2"); unicode-range: ${subset.range}; }`;
}

export function builtinFontFaceCss(fontList: BuiltinFont[] = builtinFonts): string {
  const rules: string[] = [];
  for (const font of fontList) {
    const styles: ("normal" | "italic")[] = font.italic ? ["normal", "italic"] : ["normal"];
    const weights = font.variable ? ["400-700"] : ["400", "700"];
    for (const style of styles) {
      for (const weight of weights) {
        for (const subset of SUBSETS) rules.push(face(font, style, weight, subset));
      }
    }
  }
  return rules.join("\n");
}

const STYLE_ID = "quill-builtin-font-faces";

/** Install the bundled font faces into a document (the app shell or a Foliate chapter). */
export function installBuiltinFontFacesInDocument(doc: Document) {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  } else if (style.textContent) {
    return;
  }
  style.textContent = builtinFontFaceCss();
}

export function installBuiltinFontFaces() {
  installBuiltinFontFacesInDocument(document);
}
