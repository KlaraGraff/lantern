# 1 — Grounded Book Chat, Phase 3: Enhancements

Issue: https://github.com/KlaraGraff/quill/issues/1
Read first: [architecture overview](1-grounded-book-chat-overview.md).
Requires: phases 1–2 shipped.

Four independent tracks, in recommended order of value. Each is separately shippable
and separately skippable; re-evaluate demand after phase 2 has real usage before
building 3C/3D.

## 3A. Anthropic prompt caching on the stable prefix

**Goal:** repeated questions on the same book (even across new conversations) reuse the
cached stable prefix — role + metadata + overview block — paying ~0.1× on hits.

- `src-tauri/src/ai/anthropic.rs`: the Messages API accepts `system` as an array of
  content blocks with `cache_control: {"type": "ephemeral"}` on the last stable block.
  Restructure request building: accept the system content as *two* logical parts
  (stable, variable). Backend split point: `build_chat_system_content` already
  assembles in stable→variable order (overview D6); change it to return
  `SystemContent { stable: String, variable: String }` and have non-Anthropic providers
  concatenate (byte-identical to today — assert in a test), while Anthropic emits
  `[{type:"text", text: stable, cache_control:{type:"ephemeral"}}, {type:"text", text: variable}]`.
- Only mark blocks ≥ 1024 token-estimate (provider minimum cacheable size) — below
  that, emit a single uncached block.
- OpenAI-compatible providers: automatic prefix caching server-side; the stable-first
  ordering is already optimal. No change.
- Cache hit rate is invisible client-side unless usage fields are surfaced; out of
  scope to display.
- Tests: request-body JSON snapshot for anthropic with/without stable block ≥ threshold;
  non-Anthropic byte-identical assertion.

## 3B. Short-book full-text path

**Goal:** books whose entire text fits a modest budget skip retrieval and inject
everything — highest answer quality, citations still work.

- In `build_chat_system_content`: if index ready AND
  `SUM(token_estimate)` over the book's chunks ≤ setting `ai_full_text_threshold`
  (default 30_000) → instead of `retrieve(...)`, emit ALL chunks in order in the same
  `[S#]` excerpt-block format (markers = chunk order; same untrusted framing; same
  `CitedSource` return so citations render identically). The block belongs to the
  **stable** part (it never varies per question) — combined with 3A this makes
  follow-up questions on short books nearly free.
- Skip the overview block when full text is injected (redundant; saves budget) — but
  keep summaries generated/synced for the Chats-page listing use and future features.
- Settings: numeric threshold is backend-only (no UI); flip via the settings table.
  Document in the settings row hint that short books use full text automatically.
- Tests: threshold boundary (at/over), marker continuity, stable/variable split
  interaction with 3A.

## 3C. Optional vector retrieval (hybrid)

**Default off** (`ai_vector_retrieval`). Build only if post-phase-2 usage shows lexical
recall gaps (e.g. paraphrased thematic questions missing relevant passages).

- Crate: `sqlite-vec` (bundled loadable extension with a Rust init; verify current
  rusqlite integration story at implementation time). New device-local table
  `book_chunk_embeddings(chunk_id TEXT PRIMARY KEY, embedding BLOB)` + vec0 virtual
  table, dimensions fixed by the chosen embedding source.
- Embedding source, in order of preference: active profile's OpenAI-compatible
  `/embeddings` endpoint if the provider exposes one (probe once, cache result);
  otherwise the toggle stays disabled in UI with a hint (Anthropic/CLI providers have
  no embeddings API — D1 rationale).
- Hybrid merge: BM25 top-12 and cosine top-12 → Reciprocal Rank Fusion
  (`score = Σ 1/(60 + rank)`), then the existing neighbor-expansion/budget pipeline
  unchanged.
- Embedding generation piggybacks on `ensure_index` (post-chunk step, batched, only
  when toggle on and source available). Toggle-on with an existing index backfills
  lazily on next `ensure_index`.
- Settings row under the phase-1 toggle: `settings.ai.vectorRetrieval` +
  hint (mentions provider requirement); disabled state with reason when no source.
- Tests: RRF math, absence of embeddings degrades to pure BM25, toggle off = phase-1
  behavior byte-identical.

## 3D. PDF text extraction

**Goal:** text-layer PDFs join the grounded path; scanned PDFs remain `unsupported`.

- `src-tauri/src/pdfium.rs` already binds pdfium. In `extract.rs`, add
  `extract_pdf(path) -> AppResult<Vec<SectionText>>`: per-page text via pdfium's text
  API; a "section" = a page (`section_index` = page index,
  `section_title = "Page {n}"` i18n'd at display time, `section_href = NULL`); blocks
  from line-grouping heuristics (blank-line gaps). If total extracted text < 500 chars
  for a >5-page document, treat as scanned → `unsupported` (the existing
  `reader.pdfNoTextLayer` precedent).
- Citation navigation: PDFs render in a page-based reader — navigate to the page
  (find the existing PDF page-navigation path used by bookmarks in the PDF reader;
  `supportsCfiNavigation` is false for PDFs, so `navigateToSource` gains a PDF branch
  that calls the page-jump with `source.sectionIndex`). Flash-highlight is
  out of scope for PDFs; page landing is enough.
- Tests: extraction on a small fixture PDF; scanned-PDF detection; chunker integration
  (pages as sections).

## Verification

- [ ] 3A: two consecutive questions on the same book produce identical stable blocks
      (byte-compare in test); Anthropic request JSON carries `cache_control`; other
      providers' requests unchanged.
- [ ] 3B: a short EPUB answers with full-text grounding (all markers available);
      citation chips still jump; a long book stays on retrieval.
- [ ] 3C (if built): toggle off → identical retrieval to phase 1; on with a compatible
      provider → hybrid results include paraphrase matches missed by BM25 (manual
      spot-check); on with Anthropic-only → UI explains unavailability.
- [ ] 3D (if built): text PDF gets grounded answers with page-level citations jumping
      to pages; scanned PDF stays `unsupported` with today's chat behavior.
