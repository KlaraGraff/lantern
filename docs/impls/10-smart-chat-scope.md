# Impl — Smart Chat Scope (#10)

Feature spec: [10-smart-chat-scope.md](../features/10-smart-chat-scope.md)

Four independent behaviors shipped together: scope chips, viewport fallback,
ungrounded-answer policy, and an LLM intent tie-break. Backend first (unit-tested),
then frontend wiring.

## Backend (`src-tauri/src/commands/ai/`)

### New `ai_chat` parameters (both optional; absent = today's behavior)

- `scope_override: Option<String>` — `"selection" | "section" | "book"` from the chips.
  Absent or unrecognized = Auto.
- `viewport_text: Option<String>` — text of the currently visible reading area, captured
  by the reader at send time. Backend re-truncates defensively (UTF-8-safe, ~8 KiB).

### Routes (`routing.rs`)

- New variants `ViewportContext` / `ViewportContextVocabulary`
  (`"viewport_context"` / `"viewport_context_vocabulary"`), modeled on the
  SelectedContext pair: evidence lives outside the index, so they are exempt from the
  inheritance snapshot gate in `resolve_inherited_route`.
- `route_for_override(override, has_selection, has_viewport, section_available, vocab)`:
  - selection → SelectedContext* when the latest message carries `[Selected passage]`,
    else ViewportContext* when viewport text exists, else fall through to Auto.
  - section → CurrentSection* when a section index is available, else
    CurrentSectionUnavailable (which is now an ungrounded answer, not a refusal).
  - book → WholeBook*.
- `classify_chat_route` gains `has_viewport: bool`:
  - passage request fall-through (today's unconditional CurrentSectionUnavailable) →
    ViewportContext* when viewport text exists.
  - vocabulary fall-through without a section index → ViewportContextVocabulary when
    viewport text exists.
  - inherited ViewportContext* re-resolves against the *current* viewport (follow-ups
    track what is on screen now); without viewport text it degrades to Generic.

### Ungrounded answers (`ai.rs`)

- Delete the three hardcoded refusal strings and their `spawn_local_stream` dispatch;
  `*_unavailable` routes now flow through `spawn_routed_stream` like everything else.
- Rewrite the three `append_chat_route_instructions` branches: answer from supplied
  partial evidence (viewport, quote) plus the model's own knowledge of the book;
  mandatory opening disclosure that the answer is not grounded in the book's text;
  honesty escape hatch ("if you don't know this book, say so"); the vocabulary variant
  must present results as recalled examples, never as a scan.
- Viewport text is injected into `system_content.variable` (it changes per message —
  keeping it out of `stable` preserves prompt caching) with the standard
  untrusted-content framing, for viewport routes and as partial evidence on ungrounded
  routes.

### Intent tie-break (`intent.rs`, new)

- Trigger: resolved route is Generic, no explicit scope in the message, no inherited
  route, Auto mode, and a book is open.
- One `complete_with_failover` call (max_tokens ≈ 8, ~8 s timeout): classify into
  `passage | section | book | generic`. Mapping: passage → viewport route when
  available else Generic; section → CurrentSection* / ungrounded; book → WholeBook*.
- Any error/timeout/unparseable label → keep the keyword result. The classifier can
  only upgrade routing, never break it.
- An inferred book scope is not explicit spoiler consent — spoiler-guard logic is
  untouched (`has_whole_book_intent` still reflects only the typed message).

### Tests

Override mapping table; viewport fall-throughs; viewport inheritance across snapshot
mismatch; ungrounded prompts contain disclosure wording and no refusal wording;
viewport block framed as untrusted; intent label parsing; scoped-history handling of
the new routes.

## Frontend

- `useAiChat.ts`: extend `AiChatRoute`; `BookContext.getViewportText?: () => string |
  undefined` (called at send time); `send` options gain `scope`; invoke payload gains
  `scopeOverride` / `viewportText`.
- `useFoliateView.ts`: expose `getVisibleText()` — `view.lastLocation?.range?.toString()`
  (the paginator already reports the visible Range on every relocate), trimmed and
  capped (~6 k chars).
- `Reader.tsx`: thread `getVisibleText` into AiPanel's book context.
- `AiPanel.tsx`: chips row (Auto/Selection/Chapter/Book) above the composer; sticky per
  panel; resets to Auto on chat or book switch; suggested prompts also send the active
  scope. Selection chip with no pending quote silently uses the viewport (backend rule).
- `MessageBubble.tsx`: badge for viewport routes ("based on the visible area"); the
  `*_unavailable` badge copy changes from "could not answer" to "not grounded in book
  text". `ChatDetailView` (standalone chats) is untouched — no viewport, no chips.
- i18n: `ai.scope.*` chip labels; `ai.sectionContext.viewport`; reworded
  `ai.sectionContext.unavailable` / `wholeBookUnavailable` / `wholeBookVocabularyUnavailable`.

## Figma design prompt

> In the reading app's AI chat panel, add a compact scope selector above the message
> input: four quiet segmented chips — Auto, Selection, Chapter, Book. Auto is the
> default and visually calm; the active chip is clearly distinct but the row must not
> compete with the composer (this is a power-user control, not a wizard step). It sits
> between the pending-quote chip and the textarea and must work in both light and dark
> themes and in Chinese and English. Also design two small inline badges that appear
> above an assistant answer: "based on the visible area" and "not grounded in book
> text" — informational, low-emphasis, icon + short text, consistent with the existing
> section-context notice.

## Sequencing

1. Backend routes + override + viewport + ungrounded prompts + tests.
2. Intent tie-break + tests.
3. Frontend wiring + i18n.
4. Full check suite; commit docs and code separately.
