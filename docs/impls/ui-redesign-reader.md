# UI redesign v3: the reader 「浮笺」

Status: in progress (3a).
Design source: §§9–12 of `design/lantern-ui-redesign-2026-10-16.md` and the canvas row ⑧ boards (`ReaderProto`, `ReaderToc`, `ReaderExplain`, `ReaderPinnedNight`) in the project's shared folder; rendered at <https://claude.ai/artifact/JBpitzgxmkchUGmDANjZnM>. The reader now opens in the library window: [`ui-redesign-single-window.md`](ui-redesign-single-window.md).

## Why

Today the reader is three columns: a TOC or search panel welded to the left edge, the page, and a 440px AI / traces panel welded to the right, each a full-height column with a 1px rule. The design keeps one sheet of paper. A side appears when you ask a question of it and goes when you are done:

| Question | Home | Opens from |
| --- | --- | --- |
| Where am I, where next | Left: the spine, then the TOC card | Resting on the left edge · the top bar · ⌘1 |
| What does this sentence mean | Beside the sentence, gone when used | Selecting text · clicking a word · ⌘E / ⌘J |
| What did I leave in this chapter | The right card's 「本章」 | The top bar's 助手 · ⌘2 · the bookmark ear |

## The state model

Each side is `{ view, mode }`. `mode` is one of four values:
- `closed`
- `peek`: left only. Resting on the spine opens it, and leaving takes it away.
- `float`: a card over the page. The page does not reflow.
- `pinned`: the card stays where it is and only its material changes. The page gives it room and reflows once.

`src/pages/reader/reader-sides.ts` holds the model as pure functions. The reader's existing `tocOpen / searchOpen / sidePanel` flags are derived from it (`legacyPanels`) and written back through `withLegacy`, so the forty-odd call sites and `narrow-panels.ts`, with its tests, keep their meaning.

Reflows happen only on pin, unpin, and dragging a pinned card's width. Peeking, opening a float, switching views, hiding the top bar and turning pages never reflow. A pin is one transition of a slot's width. `useDockTransition` (extracted from `useSidePanelResize`) freezes the paginator for its duration and always releases it, on `transitionend` or a 260ms fallback.

Below 48rem nothing changes: every side is today's full-page sheet.

## Pull requests

**3a: the model and the left side (this one).**
- `reader-sides.ts` and its tests. Reader state moves onto it behind the legacy setters.
- `useDockTransition`. `useSidePanelResize` uses the same freeze for its drag.
- The left side on a wide screen. A 3px spine runs down the left edge: one segment per top-level chapter, filled by the book's progress. Resting within 24px of the edge for 120ms peeks the TOC card; leaving the edge and the card for 180ms ends the peek, and a press on the edge cancels it. The card is 272px, inset 12px from the window, radius 14, opaque, with a far shadow. Its header names the view, switches between TOC and search, and holds the pin. A 「当前位置」 card shows the chapter, pages left and a progress bar. Chapter rows carry timeline dots: read filled, current ringed, unread hollow. Pinned, the card keeps its place, changes to a seated shadow with a hairline, and the page gives it 296px.
- Choosing a chapter closes a floating card and leaves a pinned one.

**3b: the right side and the chrome.**
- The answer card beside the sentence (`ExplainPopover`) gets a receipt line first: 「本章 · model · what was sent」.
- 「停靠」 turns it into the 380px right card with 「对话 | 本章」 (text with a 2px accent underline). 「本章」 lists this chapter's words, highlights and notes, people so far, and questions asked.
- Floating, the page only translates. Pinned, it reflows once. When the geometry leaves no room to float, as with the default two columns, the card opens pinned and never covers text.
- The bookmark ear on the right edge holds an answer still streaming.
- The vocab, notes and X-Ray tabs go. Traces moves to Settings → Advanced.
- The top bar fades and becomes `inert` after two page turns, while staying in flow. The status row becomes one 28px line.
- An Esc dispatcher closes things in stack order: popover → card → slide card → paper.
- A 「← 书架」 label replaces the bare back arrow, and Esc on the bare page goes back.

**3c (small).** `getEffectivePageColumns` drops to one column when a column would be narrower than 480px, so the pinned-plus-two-columns state is not cramped.

## Decisions (3a)

- **Bookmarks are not a third left view.** They are rows in the notes list today (`side-panel.ts`), and 「本章」 in 3b is where this chapter's marks live. The TOC card switches only between TOC and search.
- **The spine is filled from book progress, not from per-chapter reading history.** A chapter before the current one counts as reached, not read (design §11 names this as acceptable for a first version). Where a format has no section fractions (PDF, plain text), the spine is one segment.
- **"约 X 分钟" is left off the position card for now.** There is no per-chapter word count in memory; pages left come straight from the paginator.
- **Which sides open pinned is remembered on the device** (`localStorage`), not in the synced settings: it depends on the screen's width, and a laptop and a desktop want different answers.
- **The edge peek has no setting yet.** The design asks for a way to turn it off; it ships with 3b's settings changes.

## Tests

- `tests/reader-sides.test.ts`: derivation to the legacy flags, opening modes, peek and its end, pin toggling, slot widths, and which transitions reflow.
- `tests/reader-spine.test.ts`: spine segments from chapters, section fractions and progress.

## Figma prompt

The reader on a wide window as one sheet of warm paper with no side columns. Along the left edge, a hairline spine of short segments, one per chapter: those behind the reader in solid accent, the current one part-filled, the rest pale. A second frame shows the TOC as a floating card that has slid out from the spine, inset from the window edge with rounded corners and a soft far shadow. Its header reads 目录 with a chapter count, a search toggle and a pin. Below that, a tinted position card shows the chapter name, "剩 N 页" and a thin progress bar, then the chapter list with a vertical timeline: filled dots before, a ringed dot at the current chapter, hollow dots after. A third frame shows the same card pinned: the shadow is lower with a hairline edge, and the page has moved over to make room. States: spine only, peek, floating, pinned, dark theme, narrow (unchanged full-page sheet).
