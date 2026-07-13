import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { customFontFamily, setCustomReaderFonts } from "./reader-settings";

export interface CustomFontRecord {
  id: string;
  family_name: string;
  format: string;
  file_size: number;
  file_path: string;
  created_at: number;
}

let loadedCustomFonts: CustomFontRecord[] = [];

export function customFontFaceCss(records: CustomFontRecord[] = loadedCustomFonts) {
  return records.map((font) => (
    `@font-face { font-family: ${customFontFamily(font.id)}; src: url("${convertFileSrc(font.file_path)}"); font-display: swap; }`
  )).join("\n");
}

/** Install local font faces into a Foliate chapter document. */
export function installCustomFontFacesInDocument(doc: Document, records: CustomFontRecord[] = loadedCustomFonts) {
  const styleId = "quill-custom-font-faces";
  let style = doc.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = styleId;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = customFontFaceCss(records);
}

export function installCustomFontFaces(records: CustomFontRecord[]) {
  loadedCustomFonts = records;
  setCustomReaderFonts(records);
  const styleId = "quill-custom-font-faces";
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
