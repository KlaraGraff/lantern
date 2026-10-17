# UI redesign v2: the reader opens in the library window

Status: in progress.
Decision: maple chose the single-window reader on 2026-10-17 (the design thread's recommendation, §7 item 3 of `design/lantern-ui-redesign-2026-10-16.md` in the project's shared folder). Previous steps: [`ui-redesign-shell.md`](ui-redesign-shell.md), [`ui-redesign-home.md`](ui-redesign-home.md).

## Why

On a desktop every book used to open in an OS window of its own, so the library and the book were two places to manage. The design treats reading as a state of the one window: the cover grows into the page, the rail steps aside, and the way back is one click. A window of its own stays available for the times you want two books side by side.

## Scope

| Piece | What changes | Files |
| --- | --- | --- |
| Default | `useOpenBook` navigates to `/reader/:id` in the window you are in, on every platform. It opens a window only when the caller asks (`target.newWindow`), or when the request comes from a standalone reader window, which cannot swap its book. | `useOpenBook.ts`, `utils/reader-open-mode.ts` (new), `openReaderWindow.ts` |
| New window | ⌘-click (Ctrl-click off macOS) on a cover in the grid or list, 「在新窗口打开」 at the top of the cover's context menu, and ⌘↵ on a book in the palette (with a footer hint). All three exist only where `platform.hasWindow`. | `BookGrid.tsx`, `BookList.tsx`, `BookContextMenu.tsx`, `CommandPalette.tsx` |
| Transition | Cover → reader with `view-transition-name: book` over `--motion-travel` (260ms, ease-out-soft), the rest cross-fading. `BrowserRouter` has no view-transition support, so `utils/book-transition.ts` starts the transition and the reader route resolves it from a layout effect on its first commit (the lazy-chunk fallback or the loading screen, whichever paints first). Under reduced motion the cover does not move; both pages fade over half the time. Where the webview has no View Transitions, the navigation simply happens. | `utils/book-transition.ts` (new), `App.tsx`, `Reader.tsx`, `index.css` |
| MCP | `mcp:open-reader` opens the book the way a click would, in the library window. | `App.tsx` |
| Notes jump | 「查看全部笔记」 from a learning card goes to the library's notes by route when the reader is in the library window; a standalone reader still hands off to the main window. | `Reader.tsx`, `Home.tsx` |

Unchanged on purpose: the reader's in-window chrome is the one phones already use (back arrow, `leaveReader` returning to wherever you came from), and the rail is not mounted on the reader route. Exit saving already covers a reader in the `main` webview (`reader_exit_register` keys by label), so no backend change was needed.

## Not in this PR

- **Esc as the last step back, and 「← 书架」 in the top bar.** Both belong to the reader chrome that step 3 (「浮笺」) rebuilds, where the Esc stack is defined.
- **Keeping the reader mounted while you are on the shelf.** Returning to a book reopens it at the saved position; keeping the foliate view alive across routes is a larger change to the reader's lifecycle and is left for after step 3.

## Tests

- `tests/reader-open-mode.test.ts`: when a book gets a window (library window, standalone reader, phone), the ⌘/Ctrl gesture per platform, that no open path calls `openReaderWindow` directly, and that the reader route reports its first commit.

## Figma prompt

Two frames of the same library window, a moment apart. First: the shelf, one cover lifting slightly under the pointer. Second: the same window mid-transition, the cover enlarged and moving towards the full window as the shelf fades behind it, ending as the reader page with the rail gone and a back control at the top left. A third small frame shows the cover's context menu with 「在新窗口打开」 as its first item, and the command palette with a book selected and a "⌘↵ 新窗口" hint in its footer.
