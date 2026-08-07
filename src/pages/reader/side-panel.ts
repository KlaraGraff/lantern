/**
 * The reader's right-docked panel is one exclusive slot, not several
 * independently-toggled booleans — opening one panel always closes any other
 * by construction, so nothing needs a manual mutual-exclusion effect.
 * "Traces" (痕迹) holds bookmarks/highlights/vocab/notes as tabs; "ai" holds
 * chat/X-Ray. All four traces tabs are siblings: highlights used to hang off
 * bookmarks in a second, nested tab bar, which put "书签" inside "书签".
 */
export type SidePanel = "traces" | "ai" | null;
export type TracesTab = "bookmarks" | "highlights" | "vocab" | "notes";
export type AiTab = "chat" | "xray";

/** Clicking an already-open panel's toolbar button closes it; any other panel opens it. */
export function toggleSidePanel(current: SidePanel, panel: Exclude<SidePanel, null>): SidePanel {
  return current === panel ? null : panel;
}
