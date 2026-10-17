# UI redesign v2, step 1: the shell

Status: in progress.
Design source: v2 boards in the canvas (<https://claude.ai/artifact/JBpitzgxmkchUGmDANjZnM>, rows ④–⑦: structure, palette, motion, clickable prototype) and §§5–8 of the written proposal (`design/lantern-ui-redesign-2026-10-16.md` in the project's shared folder). Colour and type tokens are step 0, [`ui-redesign-paper-lantern.md`](ui-redesign-paper-lantern.md).

## Why

The library window spends 224px on a two-level text sidebar (library filters, memo sections, collections, profile) whose rows answer three different questions. v2 splits them: a 64px icon rail says *which workspace* you are in, the shelf's own filters move into the shelf as chips, and everything else is one keystroke away in a command palette. Transient messages (import, sync, update) stop interrupting from the centre of the window and settle in one corner.

## Scope

| Piece | What changes | Files |
| --- | --- | --- |
| Icon rail | 64px column: lantern mark, five workspaces (书库 · 学习 · 笔记 · 问答 · 历程), then ⌘K and the profile/settings button at the foot. 学习 carries a dot while reviews are due. Desktop only; under `md:` the drawer keeps the full `Sidebar`. | `NavRail.tsx` (new), `Home.tsx` |
| Shelf chips | 全部 / 正在读 / 读完 and every collection become one chip row under the shelf title, with counts. Collection create, rename, delete (context menu) and drag-to-reorder move with them. | `ShelfChips.tsx` (new), `Home.tsx` |
| Sidebar | Becomes drawer-only: the desktop width, resize grip and stored width go. | `Sidebar.tsx` |
| Command palette | ⌘K / Ctrl+K in the library window, or the rail button. Groups: books (backend search), words (local list, prefix first), notes (annotation search), commands (workspaces, import, start review, theme, settings sections). ↑/↓ moves, ↵ runs, Esc closes. Results come from local data only. | `command-palette/*` (new), `App.tsx` |
| Toasts | One bottom-right stack in the library window. The shared `Toast` primitive portals into it when present, so update / quiz-ready / undo notices move there with no change of their own; reader windows keep today's top-centre position. Import progress, import errors and sync progress become toasts; the centred import overlay goes. | `ui/Toast.tsx`, `toast-stack.tsx` (new), `Home.tsx` |
| Motion | Adds `--motion-travel: 260ms` beside the existing three durations, plus `.motion-workspace` (switching workspace: fade + rise 6px, 140ms), `.motion-toast-in` (rise 12px, 220ms) and `.motion-palette` (scale .98→1 from the top centre, 140ms). Reduced motion keeps the fade and halves the time — only transform is dropped. Existing classes are untouched. | `index.css` |

Not in this step: chapter results in ⌘K. The library database has no chapter → location index (`book_difficulty_sections` keeps titles but no href/CFI), so chapter jumps arrive with the reader-window palette in step 3, where the TOC is already in memory.

## Decisions

- **Five workspaces, no separate 书架.** The prototype's home *is* the shelf with a dashboard on top (step 2), so a second shelf item would point at the same page. 书库 is renamed 首页 when step 2 lands.
- **Shelf chips are desktop-only.** On a phone the drawer already holds the same filters; doubling them in the header would cost a row of a small screen for nothing.
- **Toast placement is the container's decision, not each toast's.** Every existing `<Toast>` keeps its call site; only the primitive learns where it lives. Bottom-right would cover the chat composer in a reader window, so the stack is only mounted outside `/reader`.
- **Palette commands go through the same doors as clicks.** Opening a book uses `useBookOpenGate`, notes use `useOpenBook`, settings use `openSettings`, workspaces and import are window events Home already owns.

## Tests

- `tests/command-palette.test.ts` — matching and ranking, selection wrap, command list (MCP section hidden where unsupported).
- `tests/mobile-home-drawer.test.ts` — updated: the desktop shell is now the rail; the drawer contract is unchanged.

## Figma prompt

Library window, desktop. Replace the text sidebar with a narrow tonal rail on the left: the lantern mark at the top, five stacked icon-and-word buttons for the workspaces (the current one sits on a raised paper tile), and at the foot a search button labelled ⌘K above a round initial avatar. To the right, the shelf: serif title, a search field and sort control on one row, then a single row of quiet chips for 全部 / 正在读 / 读完 and the reader's collections, each with a small count, the active chip in the accent tint, a trailing "+" chip. Show the command palette open over a dimmed window: a centred card near the top with a large input, grouped results (words, books, notes, commands) with the selected row tinted, and a footer of key hints. Show a toast stack in the bottom-right corner: an import in progress with a spinner, and a sync progress toast above it. States: rail item hover / current / with a due dot; chip hover / active / renaming; palette empty, loading, no results.
