# UI redesign: 「纸灯」 (paper lantern)

Status: step 1 shipped (tokens). The layout steps below were superseded by the v2 structure (2026-10-17); they continue as [`ui-redesign-shell.md`](ui-redesign-shell.md) and the plans that follow it.
Design source: the canvas at <https://claude.ai/artifact/JBpitzgxmkchUGmDANjZnM> (six boards: current-state diagnosis, tokens, library light/dark, reader + AI panel, settings). Research notes and the resource table live in the project's shared folder (`design/lantern-ui-redesign-2026-10-16.md`).

## Why

The 2026-10-16 review found the app's structure sound and its surface generic: pure white sidebar, content and modal separated only by 1px rules; covers auto-filled to poster width with no spine or progress; `Inter` + zinc grey + `#7c3aed`, the default look of generated dashboards. The redesign keeps the information architecture and changes the material.

## Principles

1. **The interface is paper.** Four warm greys do the layering (`bg-page` ground → `bg-muted` sidebar / tonal panels → `bg-surface` cards and content → `bg-input` fields). Borders and shadows stop being the only separators.
2. **The book is the hero.** Covers at a fixed ~150px column width with a spine and a 2px progress line; a "continue reading" card at the top of the library; serif display type for titles and book names.
3. **One accent, for actions and progress only.** Lantern amber (`#b4561f` light / `#e08a4e` dark). The violet family stays for ordered data (word-frequency bands, mastery tiers, quoted passages) and is desaturated a step so it no longer competes.

## Steps

| # | Scope | Files | State |
| --- | --- | --- | --- |
| 1 | Tokens: colours (light + dark), warm shadows, UI font stack (Plex Sans → system), serif display on the library title and wordmark, reader `original` theme accent, text-book selection colour | `src/index.css`, `src/pages/reader/reader-theme.ts`, `src/pages/Reader.tsx`, `src/pages/Home.tsx`, `src/components/Sidebar.tsx` | done |
| 2 | Library: header controls on one row, "continue reading" card, cover grid at `minmax(150px, 1fr)` with spine + progress line, drop-zone moved into the grid | `Home.tsx`, `BookGrid.tsx`, `BookList.tsx`, `Sidebar.tsx` | pending |
| 3 | Reader: 48px chrome that shares the paper colour, bottom progress bar, AI panel with 对话 / 词典 / 笔记 segmented tabs and citation chips | `Reader.tsx`, `AiPanel.tsx`, `reader/*` | pending |
| 4 | Settings: single-line section nav with search, grouped rows at 56–60px, version + sync footer | `SettingsModal.tsx`, `settings/*` | pending — coordinate with the lazy-loading change from the optimisation thread |

Each step is its own PR with before/after screenshots from the browser harness (`npm run smoke`, see `harness/README.md`).

## Tokens (step 1)

| Role | Light | Dark |
| --- | --- | --- |
| bg-page | `#f5f1e8` | `#151311` |
| bg-muted (sidebar) | `#f3eee4` | `#100e0c` |
| bg-surface | `#fdfbf7` | `#1d1a17` |
| bg-input | `#ede7db` | `#2a2521` |
| text-primary / body / secondary / muted | `#1f1b16` / `#26211b` / `#4a433a` / `#7a7064` | `#f1ebe0` / `#e6dfd2` / `#cfc6b8` / `#9a8f80` |
| border / border-light | `#e2dacb` / `#efe8da` | `#2e2823` / `#262220` |
| accent / accent-bg / accent-text | `#b4561f` / `#f6e5d6` / `#a04c19` | `#e08a4e` / `#3a2718` / `#efa068` |
| success · danger · warning | `#3b7d4f` · `#b33a2e` · `#a2731c` | `#4fa66a` · `#e25b4c` · `#e0a75a` |

Type: display = `--font-serif` (Songti SC / Georgia / Libre Baskerville); UI = `--font-sans` (IBM Plex Sans when installed, else the system face — Inter is no longer requested). Body text in the reader is unchanged; the reader themes (`paper`, `quiet`, `dark`, `eye-care`) keep their own palettes.

## Figma / Pencil prompt (for `design/lantern-desktop.pen`)

Rebuild the desktop library, reader and settings frames on a warm paper ground with a tonal sidebar, ink text and a single amber accent reserved for primary actions, selection and progress. Book covers get a left spine highlight and a soft warm drop shadow; titles use a serif display face. Dark mode is a second warm-black paper, not an inversion. Keep every existing control and route; only the material, hierarchy and spacing change.
