/**
 * The reader's right-docked panel is one exclusive slot, not several
 * independently-toggled booleans — opening one panel always closes any other
 * by construction, so nothing needs a manual mutual-exclusion effect.
 * "Traces" (痕迹) holds bookmarks/highlights/vocab/notes/context as tabs; "ai"
 * is the conversation and nothing else. All five traces tabs are siblings:
 * highlights used to hang off bookmarks in a second, nested tab bar, which put
 * "书签" inside "书签".
 *
 * Context (语境, X-Ray) is a traces tab rather than the AI panel's second tab
 * because it is a record of what you looked at in this book, like every other
 * tab beside it — the AI panel is a conversation, which is a different kind of
 * thing. With it gone the AI panel has one view, so there is no `AiTab`.
 */
export type SidePanel = "traces" | "ai" | null;
export type TracesTab = "bookmarks" | "highlights" | "vocab" | "notes" | "xray";

/** Clicking an already-open panel's toolbar button closes it; any other panel opens it. */
export function toggleSidePanel(current: SidePanel, panel: Exclude<SidePanel, null>): SidePanel {
  return current === panel ? null : panel;
}
