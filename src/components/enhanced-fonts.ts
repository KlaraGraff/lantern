import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { CJK_UNICODE_RANGE } from "./builtin-fonts";

const STYLE_ID = "lantern-enhanced-serif-face";

/**
 * The pack is a Chinese serif, so its face is fenced to CJK codepoints for the
 * same reason the system CJK wrappers are: CSS font matching runs per character,
 * and an unfenced Chinese face sitting anywhere ahead of the generic keyword
 * claims every Latin character it happens to carry a glyph for — which for a
 * Chinese font means thin, oddly-spaced Latin instead of the reader's actual
 * Latin face.
 */
function enhancedFaceCss(path: string): string {
  return `@font-face{font-family:"Lantern Enhanced Chinese Serif";`
    + `src:url("${convertFileSrc(path)}");font-display:swap;`
    + `unicode-range:${CJK_UNICODE_RANGE}}`;
}

/**
 * Where the pack currently lives, or null when none is installed. Held here
 * because Foliate chapter documents load one at a time, long after the status
 * call that first resolved the path — each new chapter needs the face declared
 * again in its own document, and has nowhere else to read the path from.
 */
let enhancedFontPath: string | null = null;

/** Declare the pack inside one document — the app shell, or a Foliate chapter. */
export function installEnhancedFontFaceInDocument(doc: Document, path: string | null): void {
  doc.getElementById(STYLE_ID)?.remove();
  if (!path) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = enhancedFaceCss(path);
  (doc.head ?? doc.documentElement).append(style);
}

/**
 * Fired after the pack is installed or removed, so documents that are already
 * open can pick it up. Without it, downloading the pack while reading changes
 * nothing on screen until two chapter navigations later — the current chapter
 * document had its style set at load and nothing revisits it.
 */
export const ENHANCED_FONT_FACE_EVENT = "enhanced-font-face-loaded";

export function installEnhancedFontFace(path: string | null): void {
  enhancedFontPath = path;
  installEnhancedFontFaceInDocument(document, path);
  window.dispatchEvent(new CustomEvent(ENHANCED_FONT_FACE_EVENT));
}

/** For chapter documents, which need the path the app shell already resolved. */
export function installEnhancedFontFaceInChapter(doc: Document): void {
  installEnhancedFontFaceInDocument(doc, enhancedFontPath);
}

export async function loadEnhancedFontFace(): Promise<void> {
  const value = await invoke<{ localPath: string | null }>("enhanced_font_status");
  installEnhancedFontFace(value.localPath);
}
