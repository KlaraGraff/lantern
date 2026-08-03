# 10 — Smart Chat Scope

GitHub issue: https://github.com/KlaraGraff/lantern/issues/10

Implementation plan: [Smart chat scope](../../impls/archive/10-smart-chat-scope.md)

## Motivation

Chat routing decides, per message, which source material the model receives: a selected
passage, the current section, the whole book, or retrieval snippets. Today that decision
is made entirely by bilingual keyword matching, and every gap in it degrades the
experience in one of two ways:

- **Canned refusals.** "解释这段" without a selection, any section question while the
  index is still building, and any whole-book question on an index-less book (e.g. some
  PDFs) all stream a hardcoded local refusal telling the user to wait or select text.
  The model is never even called. For well-known books this is absurd: the model could
  give a genuinely useful answer from its own knowledge.
- **Silent misrouting.** Ambiguous phrasing falls through the keyword cascade to a
  default the user cannot see or correct. The user's only recourse is rewording the
  question until a keyword happens to match.

The product goal, aligned with the user (2026-07-26): **answer instead of refuse, route
intelligently, make scope visible and correctable.**

## Experience

### 1. Scope chips in the composer

A row of small chips above the chat input: **Auto / Selection / Chapter / Book**
(自动 / 选区 / 本章 / 全书).

- **Auto** (default): smart routing decides — keywords, conversation inheritance, and
  the ambiguity classifier (below).
- A manual pick forces that scope for subsequent messages and skips all guessing. The
  choice is sticky within the panel until changed; switching chats or books resets to
  Auto.
- **Selection** uses the pending quote when one is attached, otherwise the currently
  visible reading area.
- Chips are compact and quiet (this is a power feature, not a wizard step); the active
  chip is visually distinct.

### 2. Viewport fallback

"Explain this passage" with nothing selected stops being a refusal. The reader always
knows what is on screen; that visible text becomes the implicit passage. The answer
carries a badge: **"based on the visible area"** (基于当前屏幕内容). No confirmation
step — the user saying "this passage" means the passage in front of them.

### 3. Ungrounded answers instead of refusals

When reliable source text is unavailable (index building, unsupported format, grounding
disabled), the model now answers anyway, drawing on its own knowledge of the book — with
mandatory disclosure:

- The answer starts by stating it is not grounded in the book's actual text.
- The answer bubble carries a **"not grounded in book text"** (未基于原文) badge.
- Any available partial evidence (viewport text, an attached quote) is still supplied
  and preferred.
- The three hardcoded refusal texts (`spawn_local_stream` paths) are removed.

Trade-off accepted by the user: for niche books the model may confabulate; the badge and
disclosure are the mitigation. Grounded answers remain the default whenever an index is
ready — this policy only changes what happens when grounding is impossible.

Exhaustive whole-book vocabulary scans keep their honesty rules: coverage statements
stay, and an ungrounded "scan" must present itself as recalled examples, not as a scan.

### 4. LLM intent tie-break

When the keyword cascade cannot classify the message (today's fall-through to generic
retrieval), one tiny classification call to the user's configured provider picks the
scope. Clear phrasings keep the zero-latency keyword fast path; only ambiguous messages
pay the extra ~0.5–1 s. Classifier failure or timeout falls back to the keyword result —
routing never breaks because the classifier is down.

## Non-goals

- No new settings. The classifier and viewport fallback are always on; a kill switch can
  be added later if cost or latency complaints appear.
- No change to spoiler-guard semantics.
- No redesign of the grounding/index pipeline.
