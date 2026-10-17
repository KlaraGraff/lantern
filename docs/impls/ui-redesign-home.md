# UI redesign v2, step 2: home and learn

Status: shipped (PR #23). Next: [`ui-redesign-single-window.md`](ui-redesign-single-window.md).
Design source: canvas boards 「v2 首页」 and 「v2 学习」 (<https://claude.ai/artifact/JBpitzgxmkchUGmDANjZnM>) and §5 / §8 of the written proposal (`design/lantern-ui-redesign-2026-10-16.md` in the project's shared folder). Step 1 (rail, chips, ⌘K, toasts) is [`ui-redesign-shell.md`](ui-redesign-shell.md).

## Why

Opening the app should answer "where was I, and what is there to do today" before it shows a wall of covers. v2 puts a short dashboard on top of the shelf: the book you were reading with a way straight back into it, and today's numbers. The learn workspace gets the same treatment: today's review and the last quiz first, the word list below.

## Scope

| Piece | What changes | Files |
| --- | --- | --- |
| Home dashboard | Desktop only, on top of the shelf. A greeting with the date, a ⌘K field and Import. A 「接着读」 card: cover, title, author · chapter, progress with an estimate of the time left, Continue reading and Book page, and beside it 「上次读到」: the chapter and the words looked up there. Then three tiles: words due (→ review), reading time over the last 7 days with a bar per day (→ 历程), new words and lookups this week (→ 学习). Hidden while the shelf search has text. | `pages/home/HomeDashboard.tsx`, `pages/home/home-dashboard-model.ts` (new), `Home.tsx` |
| Shelf | On a desktop the shelf scrolls with the dashboard as one page, under its own 「书架」 heading, with the chips, a compact search, sort and the view toggle on one row. The phone layout is unchanged. | `Home.tsx` |
| Covers | The wide grid uses 148px columns, a spine shade, a serif title, a 2px progress line with the percentage, and 「已读完」 as text instead of a badge. Hover lifts the cover 3px (90ms, off under reduced motion). The grid's last cell is the import tile; the list view keeps the footer. The phone's column modes are unchanged. | `BookGrid.tsx`, `Home.tsx` |
| Rail | 书库 becomes 首页, with a house icon. | `NavRail.tsx`, i18n |
| Learn | Desktop: a dark 「今日复习」 card (count, books it comes from, Start review) and a 词卷 card (last score and date, or the unfinished paper to resume, or none yet) above the word list. They replace the header's Flashcards and Quiz buttons, which stay on a phone. The mastery label on each word wears the data ramp (`--color-mastery-*`) as a swatch instead of brand orange and success green. | `vocab/LearnTodayRow.tsx` (new), `DictionaryContent.tsx` |
| Harness | The dashboard fixtures now have the real camelCase shapes (`get_reading_stats_dashboard`, `get_vocab_learning_dashboard`), the reading book has lookups in two chapters, and `get_reading_pace` answers. | `harness/invoke-fixtures.ts` |

## Decisions

- **「上次读到」 is built from stored facts, not an AI summary.** The library keeps no "current chapter"; the newest lookup's chapter is the closest stored fact, and it is never ahead of the reader. The AI chapter summaries in `ai_index_details` cover whole chapters, so they could spoil the rest of the one being read, against the product's 「不剧透」 promise. A summary of the last session belongs with the reader work in step 3, where the reading position is known.
- **The tiles are what the data can answer.** The board's "today's reading time" becomes the last 7 days because a single day is usually zero in the morning; the chapter-quiz tile from the brief becomes the 词卷 card on the learn page, since there is no per-chapter quiz to count. There is no reading streak in the backend, so none is shown.
- **The dashboard re-reads on focus and on every count refresh.** A reading session in a separate reader window ends, from the library's side, when the library window gets focus back.
- **The cover-to-reader View Transition waits for the window decision.** It only makes sense if the reader opens in the same window; with a separate reader window there is no shared element to morph. It ships with step 3 if maple picks the single window.
- **Desktop only.** The phone keeps its header and the drawer; the dashboard and the learn cards would push the shelf and the list off a small screen.

## Tests

- `tests/home-dashboard.test.ts` — greeting hours, the 7-day window across a month boundary, per-day seconds, durations, time left, last-read buckets, and the chapter-words digest (newest chapter, dedupe, cap).

## Figma prompt

Library window, desktop, with the icon rail on the left. Top of the content: a serif greeting with the date in small muted type, and on the right a search field showing the ⌘K hint beside an accent Import button. Below, one wide card: a book cover with a spine shade, then an eyebrow "接着读 · 昨天", the title in large serif, author and chapter, a thin progress bar with "37% · 约剩 4 小时", and two buttons (a dark primary Continue reading, a quiet Book page). The card's right third is a tinted panel headed 「上次读到」 with the chapter name and a row of word chips. Under the card, three equal tiles with a small icon each: words due with "开始复习", this week's reading time with seven tiny bars (today in accent), new words this week with the lookup count. Then the shelf: a serif 「书架」 heading, the filter chips, a compact search, sort and view toggle on one row, and a grid of narrow covers with spines, titles in serif, a hairline progress under the author, and a dashed import tile as the last cell. Learn workspace: a dark review card with the due count in a ring and an accent button, beside a light quiz card with the last score. States: no book in progress (no card), nothing due, no reading this week, a book with no lookups (no side panel), dark theme.
