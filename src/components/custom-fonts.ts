import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { customFontFamily, setCustomReaderFonts } from "./reader-settings";

export interface CustomFontRecord {
  id: string;
  family_name: string;
  format: string;
  file_size: number;
  file_path: string;
  created_at: number;
  /**
   * Whether the font file exists on this device yet. Fonts sync: the catalog
   * row travels through the event log and the file replicates separately, so a
   * font can be known-but-not-yet-downloaded. Older backends omit this field,
   * hence the `!== false` checks — absent means available.
   */
  file_available?: boolean;
}

let loadedCustomFonts: CustomFontRecord[] = [];

/**
 * Emit `@font-face` only for fonts whose bytes are actually here. A rule
 * pointing at a file that has not downloaded yet would fail to load and, worse,
 * make the family name look defined — the reader would render nothing rather
 * than falling back to a real face.
 *
 * The font stays *selected* either way. Availability gates rendering, not
 * selection: see the note on `installCustomFontFaces`.
 */
export function customFontFaceCss(records: CustomFontRecord[] = loadedCustomFonts) {
  return records.filter((font) => font.file_available !== false).map((font) => (
    `@font-face { font-family: ${customFontFamily(font.id)}; src: url("${convertFileSrc(font.file_path)}"); font-display: swap; }`
  )).join("\n");
}

/** Install local font faces into a Foliate chapter document. */
export function installCustomFontFacesInDocument(doc: Document, records: CustomFontRecord[] = loadedCustomFonts) {
  const styleId = "lantern-custom-font-faces";
  let style = doc.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = styleId;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = customFontFaceCss(records);
}

/**
 * The `custom-font-faces-loaded` detail carries the **whole catalog**, not just
 * the loadable subset. Listeners treat it as the set of fonts that still exist,
 * and one of them downgrades a selected `custom-` font to "system" when it is
 * missing from that set. Now that fonts sync, "the file has not arrived yet" is
 * a normal transient state rather than a deletion — filtering it out here would
 * silently reset the user's font choice while a download was in flight. Keep the
 * full list: availability is expressed by `file_available`, not by omission.
 */
export function installCustomFontFaces(records: CustomFontRecord[]) {
  loadedCustomFonts = records;
  setCustomReaderFonts(records);
  const styleId = "lantern-custom-font-faces";
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = customFontFaceCss(records);
  window.dispatchEvent(new CustomEvent("custom-font-faces-loaded", { detail: records }));
}

export function isCustomFontRecordList(value: unknown): value is CustomFontRecord[] {
  return Array.isArray(value) && value.every((font) => (
    font
    && typeof font === "object"
    && typeof (font as Partial<CustomFontRecord>).id === "string"
    && typeof (font as Partial<CustomFontRecord>).family_name === "string"
    && typeof (font as Partial<CustomFontRecord>).file_path === "string"
  ));
}

export async function loadCustomFonts() {
  const records = await invoke<CustomFontRecord[]>("list_custom_fonts");
  installCustomFontFaces(records);
  return records;
}
