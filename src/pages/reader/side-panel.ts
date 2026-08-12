/**
 * The reader's right-docked panel is one exclusive slot, not several
 * independently-toggled booleans — opening one panel always closes any other
 * by construction, so nothing needs a manual mutual-exclusion effect.
 * "Highlights & Notes" (划线笔记; internal id "traces") holds notes/vocab/
 * context as tabs; "ai" is the conversation
 * and nothing else. Bookmarks and highlights are not tabs of their own: they
 * are rows in the notes list, told apart by the cell on their left rather than
 * by which tab you had to guess first.
 *
 * Context (语境, X-Ray) is a traces tab rather than the AI panel's second tab
 * because it is a record of what you looked at in this book, like every other
 * tab beside it — the AI panel is a conversation, which is a different kind of
 * thing. With it gone the AI panel has one view, so there is no `AiTab`.
 */
export type SidePanel = "traces" | "ai" | null;
export type TracesTab = "notes" | "vocab" | "xray";

/** Clicking an already-open panel's toolbar button closes it; any other panel opens it. */
export function toggleSidePanel(current: SidePanel, panel: Exclude<SidePanel, null>): SidePanel {
  return current === panel ? null : panel;
}
