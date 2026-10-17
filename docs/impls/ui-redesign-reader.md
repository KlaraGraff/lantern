# UI redesign v3: the reader 「浮笺」

Status: in progress. 3a (PR #25), 3c (PR #26) and 3b-1 to 3b-3 (PRs #27–#29) shipped; 3b-4, the receipt line and the bookmark ear, is the last part of 3b.
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

**3a: the model and the left side (shipped, PR #25).**
- `reader-sides.ts` and its tests. Reader state moves onto it behind the legacy setters.
- `useDockTransition`. `useSidePanelResize` uses the same freeze for its drag.
- The left side on a wide screen. A 3px spine runs down the left edge: one segment per top-level chapter, filled by the book's progress. Resting within 24px of the edge for 120ms peeks the TOC card; leaving the edge and the card for 180ms ends the peek, and a press on the edge cancels it. The card is 272px, inset 12px from the window, radius 14, opaque, with a far shadow. Its header names the view, switches between TOC and search, and holds the pin. A 「当前位置」 card shows the chapter, pages left and a progress bar. Chapter rows carry timeline dots: read filled, current ringed, unread hollow. Pinned, the card keeps its place, changes to a seated shadow with a hairline, and the page gives it 296px.
- Choosing a chapter closes a floating card and leaves a pinned one.

**3b: the right side and the chrome.**
- **3b-1, the right card (shipped, PR #27).** The conversation and the traces move from a column into one 380px card inset 12px, radius 16, draggable 320–560 and shared by both views (the old 440/400 per-view widths reflowed the page on a switch). Its header switches 「对话 | 划线笔记」 with text and a 2px accent underline, and holds the pin and close. It opens floating when the text leaves room: `placeRightCard` measures the rendered text as the card opens, and the page translates left at most to a 96px left margin. Otherwise it opens *seated*, laid out as pinned without becoming the pin preference, so it never covers a word. Pinned, a 404px slot opens and the page reflows once. A drag on a pinned card moves the slot with it, so the drag's end has nothing left to animate. 「本章」 replaces 「划线笔记」 in 3b-3.
- **3b-3, 「本章」 (shipped, PR #29).** The card's second view becomes 「本章」: one list of what the reader left in this chapter, in the design's order: words, then highlights and notes (bookmarks included, auto-highlights left out by rule ④), then questions asked. A trace belongs to the chapter when the section named by its CFI's first step falls inside `currentScope` (`chapter-traces.ts`). A question is placed by the `sectionIndex` its message metadata already stores, or its selection CFI. Every row goes back to where it was made, and a question opens its conversation. The toolbar's traces button and the segment both land on 「本章」. A footer links to the whole book's notes, vocabulary and character relationships: the old three tabs, with a 「← 本章」 row above them. Narrow keeps its three tabs.
- The answer card beside the sentence (`ExplainPopover`) gets a receipt line first: 「本章 · model · what was sent」.
- **3b-4, the receipt line and the bookmark ear (this part).**
  - The answer beside the sentence is the learning card today (`ExplainPopover` only carries custom actions), so the receipt line goes on the learning card, under its header, from the first frame. It names only what `ai_learning_card` sends: the selection and its context, the book and chapter titles when there is a book, the level settings, and for a word any earlier lookups. The model leads once the answer reports it. A cached card says nothing was sent this time (`learning-card/receipt.ts`). The design's 「本章」 scope chip is left off, because this request sends a sentence, not the chapter.
  - The bookmark ear: when the right card is shut while the conversation is still answering, a 28×36 tab on the right edge holds it, its dot breathing until the answer is done. A click reopens the conversation. AiPanel stays mounted while the card is shut, so the answer keeps arriving either way.
- 「停靠」 turns it into the 380px right card (in 3b-4 the card's existing 「问 AI」 is this hand-off, minus the morph) with 「对话 | 本章」 (text with a 2px accent underline). 「本章」 lists this chapter's words, highlights and notes, people so far, and questions asked.
- Floating, the page only translates. Pinned, it reflows once. When the geometry leaves no room to float, as with the default two columns, the card opens pinned and never covers text.
- The bookmark ear on the right edge holds an answer still streaming.
- The vocab, notes and X-Ray tabs go. Traces moves to Settings → Advanced. *As built in 3b-3 the tabs leave the card's surface but stay one link away under 「全书」, since the reader has no Advanced settings section, and a vocab marker click or 「查看语境解释」 still opens them directly.*
- **3b-2, the chrome (shipped, PR #28).**
  - The top bar fades and becomes `inert` after two page turns, while staying in flow (`chrome-fade.ts`, `useChromeFade`). A turn counts only through the page-turn path, so a TOC jump or a link does not. A pointer over the bar brings it back; the inert bar's pointer events land on a wrapper around it. Settings, export, a peeking or floating card, or a pointer resting on the bar hold it up. A pinned card does not, since it is part of the page. Narrow is unchanged.
  - An Esc dispatcher closes things in stack order: popover → card → slide card → paper (`reader-escape.ts`). Popovers, menus, dialogs and slide cards keep their own Esc; the dispatcher acts only when none is up. Then it puts away a peeking or floating left card, then a floating right card, and on the bare page goes back to the shelf. A pinned card is passed by. An Esc inside a chapter document is replayed on the main document, so the same order holds wherever focus is. A standalone reader window has no shelf behind it, so its bare page ignores Esc.
  - A 「← 书架」 label replaces the bare back arrow.
- The status row becomes one 28px line.

**3c (small, shipped in PR #26).** `getEffectivePageColumns` drops to one column when half the page would be narrower than 480px (`MIN_TWO_COLUMN_SLOT`), so the pinned-plus-two-columns state is not cramped. Landscape alone no longer earns two columns. It ships before 3b, which needs it for the right card's pinned state.

## Decisions (3a)

- **Bookmarks are not a third left view.** They are rows in the notes list today (`side-panel.ts`), and 「本章」 in 3b is where this chapter's marks live. The TOC card switches only between TOC and search.
- **The spine is filled from book progress, not from per-chapter reading history.** A chapter before the current one counts as reached, not read (design §11 names this as acceptable for a first version). Where a format has no section fractions (PDF, plain text), the spine is one segment.
- **"约 X 分钟" is left off the position card for now.** There is no per-chapter word count in memory; pages left come straight from the paginator.
- **Which sides open pinned is remembered on the device** (`localStorage`), not in the synced settings: it depends on the screen's width, and a laptop and a desktop want different answers.
- **The edge peek has no setting yet.** The design asks for a way to turn it off; it ships with 3b's settings changes.

## Decisions (3b-3)

- **People so far are left out of 「本章」 for now.** X-Ray is an on-demand AI call with no stored list, and `book_person_aliases` has no first-seen position, so there is no spoiler-safe list to read. It needs a backend index first.
- **Questions read at most the 40 most recent chats**, one `list_chat_messages` each, while the card is open. There is no per-book message query.
- **The whole-book lists stay in the reader, one link down**, rather than behind a new Advanced settings section (design §12). They are where vocab-marker clicks, export and 「查看语境解释」 already land, and an Advanced section for one switch would be a settings page of its own.

## Decisions (3b-4)

- **「停靠」 is the learning card's existing 「问 AI」 for now.** It already hands the passage and the card's analysis to the right card's conversation. The 260ms morph from one element into the other is left for later.
- **The ear does not follow the anchor sentence off screen.** The design also folds a beside-the-sentence answer into the ear when a page turn takes its sentence away. The learning card is a dialog positioned by its own placement code, so that waits for the morph.
- **The edge-peek setting moves to step 4** with the rest of the settings changes.

## Tests

- `tests/reader-sides.test.ts`: derivation to the legacy flags, opening modes, peek and its end, pin toggling, slot widths, and which transitions reflow.
- `tests/reader-spine.test.ts`: spine segments from chapters, section fractions and progress.
- `tests/reader-measure.test.ts`: the two-column step-down.
- `tests/right-card-placement.test.ts`: float, step aside, or sit down.
- `tests/reader-escape.test.ts`: what one Esc does, layer by layer.
- `tests/chapter-traces.test.ts`: section from a CFI, the chapter range, which questions belong.
- `tests/learning-card-receipt.test.ts`: what the receipt says for a fresh, a word and a cached answer.
- `tests/chrome-fade.test.ts`: two turns fade the bar, a wake resets the count, a held turn does not count.

## Figma prompt

The reader on a wide window as one sheet of warm paper with no side columns. Along the left edge, a hairline spine of short segments, one per chapter: those behind the reader in solid accent, the current one part-filled, the rest pale. A second frame shows the TOC as a floating card that has slid out from the spine, inset from the window edge with rounded corners and a soft far shadow. Its header reads 目录 with a chapter count, a search toggle and a pin. Below that, a tinted position card shows the chapter name, "剩 N 页" and a thin progress bar, then the chapter list with a vertical timeline: filled dots before, a ringed dot at the current chapter, hollow dots after. A third frame shows the same card pinned: the shadow is lower with a hairline edge, and the page has moved over to make room. States: spine only, peek, floating, pinned, dark theme, narrow (unchanged full-page sheet).
