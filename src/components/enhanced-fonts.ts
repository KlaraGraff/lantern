import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export function installEnhancedFontFace(path: string | null): void {
  document.getElementById("lantern-enhanced-serif-face")?.remove();
  if (!path) return;
  const style = document.createElement("style");
  style.id = "lantern-enhanced-serif-face";
  style.textContent = `@font-face{font-family:"Lantern Enhanced Chinese Serif";src:url("${convertFileSrc(path)}");font-display:swap}`;
  document.head.append(style);
}

export async function loadEnhancedFontFace(): Promise<void> {
  const value = await invoke<{ localPath: string | null }>("enhanced_font_status");
  installEnhancedFontFace(value.localPath);
}
