# 1 — Grounded Book Chat

GitHub issue: https://github.com/KlaraGraff/quill/issues/1

Implementation plans:
- [Overview & architecture](../impls/1-grounded-book-chat-overview.md)
- [Phase 1 — Indexing + retrieval](../impls/1-grounded-book-chat-phase1-indexing-retrieval.md)
- [Phase 2 — Summaries + citations](../impls/1-grounded-book-chat-phase2-summaries-citations.md)
- [Phase 3 — Enhancements](../impls/1-grounded-book-chat-phase3-enhancements.md)

## Motivation

Ask-AI chat currently sends only book metadata (title / author / current chapter name, see
`ai_chat` in `src-tauri/src/commands/ai.rs`) plus bounded conversation history. The model
never sees the book's actual text. Answers about the book rely entirely on pretraining
knowledge: passable for famous titles, fabricated for niche books, new releases, and
personal documents. This caps the whole AI feature set at "chat vaguely about a book the
model may or may not know."

Feeding the whole book per request is not the fix: a 100k-word book is ~140k tokens per
question — expensive for BYO-key users, slow to first token, and over the context window
of many configured providers (CLI providers, local models). Reading-time questions are
sparse (minutes apart), so provider prompt caches expire between questions and would not
absorb the cost.

The north star is the NotebookLM experience — answers grounded in the actual source,
clickable citations, a book-level overview — implemented with an architecture that fits a
local-first, bring-your-own-key desktop app. Quill has one advantage NotebookLM cannot
match: it *is* the reader, so a citation can jump to the real passage in the book, not a
sidebar text viewer.

## Scope

### In scope

1. **Text foundation (device-local).** Backend text extraction for EPUB and text-format
   books (txt / markdown / html), chunked by structure into SQLite with an FTS5 index.
   CJK-aware segmentation so Chinese books search as well as English ones. Derived data:
   never synced, rebuilt from the book file on demand or when stale.
2. **Retrieval-grounded chat.** `ai_chat` gains a retrieval step: BM25 top-k chunks
   (with neighbor expansion) injected into the system prompt. Per-question context cost
   stays ~5–8k tokens regardless of book length. Works with any already-configured chat
   provider — no embedding API, no new credentials, no new onboarding.
3. **Hierarchical summaries.** One-time, lazy map-reduce pass (chapter summaries → book
   summary) using the existing provider; stored in SQLite and synced across devices.
   Answers the macro questions retrieval alone cannot ("what is this book's argument?").
4. **Citations that jump.** Answers cite the injected excerpts; citations render as
   clickable chips that navigate the reader to the passage and flash-highlight it
   (existing `flashNavigationTarget` affordance).
5. **Cost/UX controls.** Grounding on by default with a settings toggle; summary
   generation is lazy (first question in a book) and non-blocking; clear "preparing"
   states in the AI panel.
6. **Optional enhancements (default off / provider-gated):** Anthropic prompt caching of
   the stable context prefix; full-text injection path for short books; optional vector
   retrieval via `sqlite-vec`; PDF text extraction.

### Out of scope

- Cross-book / whole-library chat (single-book grounding only).
- Embedding-based retrieval as a *requirement* — it is a phase-3 opt-in enhancement.
- MCP exposure of chapter text (noted as a future consumer of the same extraction layer;
  see dropped spec `archive/18-ai-summarization.md`).
- Scanned/image-only PDFs (no text layer → index status `unsupported`, chat falls back
  to current metadata-only behavior).

## Implementation Phases

1. **Phase 1 — Indexing + retrieval.** Extraction (EPUB via `epub` + `scraper`, text
   formats via the existing `text_prepare` document model), chunking, FTS5 index with
   CJK segmentation, retrieval injection into `ai_chat`, index lifecycle (import hook,
   lazy build, staleness, delete cleanup), settings toggle. Ships user-visible value on
   its own: answers become grounded in real text.
2. **Phase 2 — Summaries + citations.** Map-reduce chapter/book summaries (lazy,
   progress events, synced via the event log), stable summary block in the system
   prompt, citation markers `[S#]` → clickable chips → reader navigation with
   flash-highlight, sources persisted in chat message metadata.
3. **Phase 3 — Enhancements.** Anthropic `cache_control` on the stable prefix,
   short-book full-text path, optional `sqlite-vec` hybrid retrieval, PDF extraction
   via pdfium.

## Verification

- [ ] Ask a factual question about a niche EPUB the model cannot know → answer quotes /
      reflects actual book text, not fabrication.
- [ ] Same flow on a Chinese-language book with a two-character name query (e.g. 宝玉)
      → relevant chunks retrieved (CJK bigram segmentation works).
- [ ] Same flow on a `.txt` book → grounded answers.
- [ ] Book-level question ("这本书讲了什么?") → answered from the book summary layer,
      not just fragments.
- [ ] Citation chip in an answer → reader jumps to the cited passage and
      flash-highlights it (EPUB and text books).
- [ ] New conversation per question: each question assembles fresh retrieval context;
      history stays small; no cross-question contamination.
- [ ] Grounding toggle off → behavior identical to today (metadata-only).
- [ ] PDF book → no crash; index status `unsupported`; chat still works as today.
- [ ] Deleting a book removes its chunks, FTS rows, index state, and summaries.
- [ ] Re-importing / editing a book file (hash change) invalidates and rebuilds the
      index; summaries flagged stale and regenerated on next use.
- [ ] All new user-facing strings exist in both `en.json` and `zh.json`.
