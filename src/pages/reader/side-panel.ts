/**
 * The reader's right-docked panel is one exclusive slot, not several
 * independently-toggled booleans — opening one panel always closes any other
 * by construction, so nothing needs a manual mutual-exclusion effect.
 * "Traces" (痕迹) holds bookmarks/vocab/notes as tabs; "ai" holds chat/X-Ray.
 */
export type SidePanel = "traces" | "ai" | null;
export type TracesTab = "bookmarks" | "vocab" | "notes";
export type AiTab = "chat" | "xray";

/** Clicking an already-open panel's toolbar button closes it; any other panel opens it. */
export function toggleSidePanel(current: SidePanel, panel: Exclude<SidePanel, null>): SidePanel {
  return current === panel ? null : panel;
}
