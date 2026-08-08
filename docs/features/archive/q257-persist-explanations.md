# q257 — Persist Explain results + Explanations tools page

> **状态：已上线** — `src-tauri/src/commands/explanations.rs` 实现了 `save_explanation`/`list_explanations`/`delete_explanation`；spec 正文自述「Status: Shipped (2026-08-07)」。

GitHub issue: https://github.com/yicheng47/quill/issues/257

**Status:** Shipped (2026-08-07)

## Motivation

[#215](https://github.com/yicheng47/quill/issues/215) added the inline **Explain** popover, but it's one-shot — the streamed explanation is discarded when the popover closes. By contrast, **Look Up** persists to Vocab. Explain has no persistence and nowhere to revisit past explanations.

The whole point is **persistence**; the Saved section is just the surface that exposes it.

## Scope

Persist explanations and surface them in a new **Notes** or **Explanations** entry under the sidebar **Saved** section, grouped with Vocab.

Persist per explanation:
- selected passage
- explanation text
- book id + title
- chapter
- cfi (for navigate-back)
- timestamp

The Saved page provides list + search + navigate-to-cfi, matching the existing Vocab saved-item pattern.

## Decision (2026-08-06)

**Explicit Save — but persistence and the list are two separate layers, and only the list is explicit.**

- **Cache layer (automatic, invisible).** Every completed explanation is written to the `explanations` table on completion, flagged `saved = 0`. Re-opening Explain on the same passage (same book + cfi + normalized passage) returns the cached row instantly at zero API cost. This is what preserves the original cost-saving goal of auto-persist: reuse never depends on the reader having pressed anything. Unsaved rows are cache, not user data — they may be pruned (e.g. keep the most recent N per book).
- **Save layer (explicit).** A Save button in the `ExplainPopover` footer flips `saved = 1`. The Explanations page lists only `saved = 1` rows — every entry on it is one the reader chose to keep, matching the Look Up → "Save to Dict" precedent rather than the Translate auto-log precedent.
- Forgetting to press Save loses nothing: re-selecting the passage hits the cache, and Save can be pressed then.

This was the deferred open question from the #215 feature spec; the user accepted the recommendation on 2026-08-06 after confirming the cache layer keeps API reuse independent of the Save decision.

## Implementation Phases

### Phase 1 — Schema + backend
- New `explanations` table (migration): id, book_id, passage, explanation, chapter, cfi, created_at, **saved (0/1, default 0)**.
- Commands in a new/existing module: `save_explanation`, `list_explanations`, `delete_explanation` — mirror the vocab saved-item flow — plus a cache-read path keyed on (book_id, cfi, normalized passage).

### Phase 2 — Capture from ExplainPopover
- Persist on completion automatically as cache (`saved = 0`); the footer Save affordance flips `saved = 1`.
- On open, check the cache first and replay a hit instead of spending an API call.
- Reuse the passage/cfi/book/chapter already available to `ExplainPopover`.

### Phase 3 — Explanations page
- `ExplanationsPanel` (+ standalone page if needed), modeled on the current Vocab saved-item surface: list, search, click-to-navigate (`onNavigateToCfi`).
- Sidebar **Saved** entry + icon.
- i18n strings in `en.json` + `zh.json`.

## Verification

- [ ] Explaining a passage persists it; it appears on the Explanations page.
- [ ] The page lists explanations with search; clicking an entry navigates to its cfi in the reader.
- [ ] Delete works.
- [ ] i18n works in both English and Chinese.

## Context

v2 follow-up explicitly deferred in `docs/impls/archive/q215-explain-and-quote.md` ("Save-Explain-as-note — v2") and the #215 feature spec's open question. Relates to #215.
