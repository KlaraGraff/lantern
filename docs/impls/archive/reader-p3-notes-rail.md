# Reader P3.2 — 页边笔记轨

Status: approved and implemented.

## Product decision

P3.2 uses the page-margin notes rail. It is part of the Reader layout and never
covers the book. AI, bookmarks, vocabulary, and notes remain mutually exclusive
Reader workspaces. At narrow widths the rail moves below the text as a fixed
bottom workspace; the horizontal desktop resize handle is hidden.

Selecting text exposes **Add note / 记笔记**. The Reader passes the original CFI
and quoted text into the editor, then clears the native selection. A free note can
also be created at the current reading position.

## Required states

- Loading and retryable load failure.
- Page-local empty state and free-note entry.
- Create and edit with a device-local recovery draft.
- Save failure that preserves the draft and allows retry.
- Delete confirmation before the irreversible mutation.
- Cards aligned to visible quoted text without overlap.
- Searchable whole-book index in the same workspace.
- Locate quote and use the shared Reader jump/return history.

The accepted visual reference is
`docs/impls/reader-p3-notes-rail-mockup.html`. The older side-panel mockup is a
discarded comparison, not the implementation target.
