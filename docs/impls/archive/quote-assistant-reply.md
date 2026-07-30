# Quote an assistant reply in the chat composer

The composer can already pin a quote from the book — the reader's "Quote" action, or a
live text selection — and the pinned text rides along with the next question. Readers
want the same move against the assistant's own answers: highlight a line the assistant
wrote, ask "why this?", and have the question carry that line instead of the reader
retyping or re-pasting it.

## Why this is not "reuse `context`"

A pinned quote reaches the model through `messageContentForApi`
(`src/hooks/useAiChat.ts:306`), which wraps it as:

```
[Selected passage]
…text…
[/Selected passage]
```

That marker is load-bearing on the backend. `is_selected_context`
(`src-tauri/src/commands/ai/routing.rs:256`) matches the literal string to pick
`ChatRoute::SelectedContext`, and that route appends:

> The user's selected passage is the primary source for this request. Do not broaden the
> answer to unrelated book sections unless the user explicitly asks for that.

Reusing the marker for an assistant reply therefore tells the model that its own earlier
words are the book's source text for this turn. Three things break at once: the route is
wrong, the passage is presented as primary evidence, and citation/grounding treat
generated prose as retrievable source. A distinct marker is not cosmetic here.

## Shape

**Granularity — selection first, whole message as fallback.** A text selection inside an
assistant bubble quotes exactly that selection; with no selection, the quote action takes
the whole message. This mirrors `takeQuote()` (`src/components/AiPanel.tsx:154`), which
already resolves an explicit pin ahead of a live selection, so the composer keeps one
notion of "the quote that is about to be sent". Whole-message-only was rejected because
answers routinely run several hundred characters and the interesting question is usually
about one clause; selection-only was rejected because "explain this whole answer again,
shorter" is a real request that should not require a manual select-all.

### Frontend

- `ChatMessage` gains `contextKind?: "passage" | "reply"`. Absent means `passage`, so
  existing rows and in-flight code paths keep their meaning with no migration.
- `ComposerQuote` gains the same field. `MessageBubble` renders a quote affordance on
  assistant bubbles that calls back with `{ text, kind: "reply" }` — the current
  selection within the bubble when there is one, otherwise `msg.content`.
- `AiPanel` routes that callback into `setPendingQuote`. The chip already renders from
  `quoteChip`; it needs a label distinguishing a quoted reply from a quoted passage.
- `send()` carries `contextKind` through to persistence and to the API payload.

### Persistence

`serializeMessageMetadata` (`src/hooks/useAiChat.ts:291`) writes a compact JSON blob, so
`contextKind` is one more optional key — no schema change, no migration. Only persist it
when it is `"reply"`, keeping existing rows byte-identical.

### API payload

`messageContentForApi` emits a distinct block for a quoted reply:

```
[Quoted from your earlier reply]
…text…
[/Quoted from your earlier reply]
```

### Backend

- `is_selected_context` must not match the new marker. It matches the literal
  `[Selected passage]`, so this holds by construction — but it needs a regression test,
  because the failure is silent and misroutes to a scope that changes the whole prompt.
- The strip helper at `routing.rs:265` lists marker pairs for question-text cleanup; the
  new pair belongs there so routing keywords are read from the reader's own words.
- The chat system content gains one line when a reply quote is present: the quoted text
  is the assistant's own earlier wording, not book source, not evidence, and not
  something to defend — the answer-discipline rules about conceding and re-deriving still
  apply to it.

## Verification

- Quoting a passage still routes to `SelectedContext`; quoting a reply does not.
- A reply quote never appears as a citable source.
- Rows written before this change still load with passage semantics.
- Asking "why did you say this?" against a quoted reply gets an answer about that claim,
  not a fresh summary of the book passage.
