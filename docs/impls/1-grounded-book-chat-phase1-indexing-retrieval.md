# 1 — Grounded Book Chat, Phase 1: Indexing + Retrieval

Issue: https://github.com/KlaraGraff/quill/issues/1
Read first: [architecture overview](1-grounded-book-chat-overview.md) — data model,
segmentation/chunking/retrieval algorithms, constants, and decisions D1–D10 are defined
there and not repeated.

## Goal

After this phase, `ai_chat` answers are grounded in the book's actual text for EPUB and
text-format books: a BM25 retrieval step injects relevant excerpts into the system
prompt. Index builds automatically (post-import and lazily), degrades silently when
unavailable (D9), and can be toggled off. No UI redesign — only a small status hint in
the AI panel and a settings row.

## Current Shape

- `src-tauri/src/commands/ai.rs`
  - `ai_chat(messages, book_title, book_author, current_chapter, request_id, app, db, secrets)`
    (~line 1031): builds one system message via `untrusted_book_metadata` + language
    clause, appends `bounded_chat_history(messages)`, calls `spawn_routed_stream`.
    **It does not receive `book_id`.**
  - `spawn_routed_stream(app, db, secrets, messages, event_name, max_tokens, request_id)`
    (~line 166) — streaming entry; leave untouched.
  - Constants block at top (`CHAT_MAX_*`, ~lines 20–23).
- `src/hooks/useAiChat.ts` — `send()` invokes `ai_chat` with
  `{ messages, bookTitle, bookAuthor, currentChapter, requestId }` (~line 593).
  `useAiChat(bookId, bookContext)` already has `bookId` in scope.
- `src/components/AiPanel.tsx` — receives `bookId` prop; renders empty-state prompts and
  the composer; status hints can mount above the composer.
- Import pipeline: `src-tauri/src/commands/books/import.rs` — computes
  `source_sha256(src)` (from `books/format.rs`) and inserts the book row.
- Book deletion: `src-tauri/src/commands/books/mutate.rs` (find the delete command; it
  already cascades related tables — chunks/index-state join that cascade).
- Text books: prepared `TextBookDocument` produced by
  `src-tauri/src/commands/books/text_prepare.rs` (blocks with `normalized_utf16`
  offsets).
- DB: migrations registered in `src-tauri/src/db.rs` `MIGRATIONS` array (last entry 22).
  Commands registered in `src-tauri/src/lib.rs` `invoke_handler`.
- Settings: key-value `settings` table; backend reads via direct query (see the
  `language` read inside `ai_chat`); frontend via `useSettings`.

## Direction

Steps in dependency order. Backend unit tests accompany each backend step (repo
convention). Run `cargo check` / `cargo test` in `src-tauri` and `npm run build` at the
end of each step.

### 1. Migration `023_ai_grounding.sql`

Exactly the DDL from the overview (all four objects — `book_summaries` is created now so
phase 2 needs no second migration; it stays empty until then). Register as entry 23 in
`db.rs`. Add a unit test near the existing db tests asserting
`CREATE VIRTUAL TABLE ... USING fts5` succeeded (e.g. insert + `MATCH` round-trip) so an
FTS5-less SQLite build fails loudly at test time.

### 2. `src-tauri/src/ai/grounding/` module

Create `mod.rs` (constants from the overview + `pub use`), `segment.rs`, `chunk.rs`,
`extract.rs`, `index.rs`, `retrieve.rs`. Wire `pub mod grounding;` into
`src-tauri/src/ai/mod.rs`.

- `segment.rs`: `segment_for_fts` per the overview spec. Tests: mixed zh/en, single CJK
  char, kana, empty string, punctuation-only.
- `chunk.rs`: `estimate_tokens`, `chunk_sections(sections: Vec<SectionText>) -> Vec<ChunkDraft>`
  per the overview. Tests: packing respects target/max; oversized single block splits at
  sentence boundary; no cross-section chunks; snippet ≤120 chars and verbatim prefix.
- `extract.rs`:
  - `extract_epub(path: &Path) -> AppResult<Vec<SectionText>>` — spine order via the
    `epub` crate, block texts via `scraper`, TOC title resolution (overview spec).
  - `extract_text_book(db, book_id) -> AppResult<Vec<SectionText>>` — consume the
    prepared `TextBookDocument` from `text_prepare.rs` (reuse its load path; do not
    re-parse the source file). Carry block source offsets through.
  - `SectionText { section_index, section_href: Option<String>, section_title: Option<String>, blocks: Vec<BlockText> }`,
    `BlockText { text: String, char_start: Option<i64>, char_end: Option<i64> }`.
  - Tests: build a tiny EPUB fixture in-memory (the `zip` crate is available; see
    existing epub tests if any) with 2 spine items → assert section order, block
    extraction, title resolution.
- `index.rs`:
  - `ensure_index(db: &Db, book_id: &str) -> AppResult<IndexStatus>` — the single entry
    point. Reads the book row (`file_path`, `source_format`), compares
    `book_index_state` (`source_sha256` via `books::format::source_sha256`,
    `index_version` vs `INDEX_VERSION`). Fresh → return `Ready`. Stale/missing → rebuild
    inside one transaction: delete old rows (`book_chunks`, `book_chunks_fts` by
    book_id), extract → chunk → insert chunks + FTS rows
    (`segment_for_fts(text, Index)`), upsert state row. `pdf` (and any other format) →
    state `unsupported`. Extraction error → state `failed` with `error`, return
    `Failed` — callers degrade (D9).
  - Status is also recorded as `building` while a rebuild runs so concurrent calls
    don't double-build: take the DB writer lock pattern used elsewhere; a second caller
    seeing `building` returns `Building` immediately.
  - Tests: build state machine (missing→ready), staleness on hash change and on
    `INDEX_VERSION` bump, unsupported pdf, failed extraction records error, delete +
    rebuild leaves no orphan FTS rows.
- `retrieve.rs`: `retrieve(...)` exactly per the overview (query build, MATCH, neighbor
  expansion, merge, budget). Tests: seeded chunks where the top hit is known; zh
  two-char query; neighbor merge of adjacent hits; budget trimming order; empty/no-match
  query → empty vec.

### 3. Index lifecycle triggers

- **Post-import**: at the end of a successful import in `import.rs`, spawn
  `tauri::async_runtime::spawn_blocking` → `ensure_index`. Failure is logged, never
  surfaced to the import flow.
- **Post-text-preparation**: text books become extractable only after preparation;
  hook the same spawn where preparation completes in `text_prepare.rs`.
- **Book deletion**: in the delete command in `mutate.rs`, delete `book_chunks`,
  `book_chunks_fts` (by book_id), `book_index_state`, `book_summaries` rows in the same
  transaction as the other cascades. Test alongside the existing delete tests.
- **Metadata edits do not invalidate** (hash unchanged) — no hook in edit paths.
- New command `ai_reindex_book(book_id)` (register in `lib.rs`): force-rebuild by
  deleting the state row then `ensure_index`. No UI button this phase; used by tests
  and future settings surface.

### 4. `ai_chat` retrieval injection

In `commands/ai.rs`:

- Add parameter `book_id: Option<String>` to `ai_chat`.
- Read setting `ai_grounding_enabled` (default true) next to the existing `language`
  read.
- When enabled and `book_id` is present:
  1. `ensure_index` (spawn_blocking; it's called on the async path). `Ready` →
     continue; `Building`/`Failed`/`Unsupported` → skip retrieval, and emit a
     one-shot event `ai-grounding-status-{request_id}` with payload
     `{ status: "building" | "unavailable" }` for the panel hint; `Building` also
     means a rebuild was kicked off so the *next* question will be grounded.
  2. Retrieval query = content of the **last user message** (`messages.last()` with
     `role == "user"`), truncated to 2_000 bytes.
  3. `retrieve(...)` → format the excerpt block exactly per the overview (markers
     `[S1]`.. in book order, untrusted-content framing, grounding instruction).
     Append to `system_content` AFTER the language clause (assembly order in the
     overview).
- Return type changes from `AppResult<()>` to `AppResult<Vec<CitedSource>>` where
  `CitedSource { marker, chunk_id, section_index, section_href, section_title, snippet, char_start, char_end }`
  (serde camelCase like other command payloads). Empty when retrieval skipped. Phase 2
  renders these; returning them now avoids a second signature change.
- Unit tests (pattern: existing `#[cfg(test)]` in `ai.rs`): grounded call injects
  excerpts + instructions into the system message; toggle off → byte-identical system
  message to today's; no `book_id` → unchanged; unsupported index → unchanged + would
  have emitted status (factor message assembly into a testable function
  `build_chat_system_content(...) -> (String, Vec<CitedSource>)` so tests don't need an
  AppHandle).

### 5. Frontend wiring

- `useAiChat.ts`: pass `bookId` in the `ai_chat` invoke payload; capture the
  `Vec<CitedSource>` result into the in-flight assistant message's metadata as
  `sources` (extend `ChatMessageMetadata` + `serializeMessageMetadata`; persisted with
  the assistant message on completion — storage only this phase, no rendering).
  Listen for `ai-grounding-status-{requestId}`; expose `groundingStatus` from the hook
  (cleared on next send).
- `AiPanel.tsx`: when `groundingStatus === "building"`, show a subtle single-line hint
  above the composer: `t("ai.groundingPreparing")`. When `"unavailable"` show nothing
  (D9 — silent degrade) — the key exists for future use.
- `SettingsModal` AI section (`src/components/settings/AiSettings.tsx`): add a row
  (follow the 73px row pattern per `CLAUDE.md`) with a `Toggle` bound to
  `ai_grounding_enabled` via `useSettings`. Copy: `settings.ai.grounding` /
  `settings.ai.groundingHint`.
- i18n: `ai.groundingPreparing`, `ai.groundingUnavailable`, `settings.ai.grounding`,
  `settings.ai.groundingHint` in `en.json` + `zh.json`.

### 6. Verification pass

Use `docs/guide/` conventions if a manual test script is customary; otherwise verify
directly.

## Figma design prompt

Minimal UI this phase; no mockup needed beyond: a one-line muted status hint above the
AI composer ("Preparing book index…" with a small spinner, auto-dismisses), and one
settings toggle row matching existing AI settings rows. Reuse existing patterns; do not
introduce new visual styles.

## Verification

- [ ] `cargo test` green, including new grounding module tests; `npm run build` green;
      eslint clean.
- [ ] Import a niche EPUB → ask a specific factual question → answer reflects actual
      text; repeat with grounding toggled off → generic/hallucinated answer (manual
      sanity check of the injection).
- [ ] Chinese EPUB, query with a 2-char name → retrieval returns relevant chunks
      (verify via logs or a temporary debug command).
- [ ] `.txt` book (post-preparation) → grounded answers; chunk `char_start/end`
      populated.
- [ ] PDF book → chat works exactly as before; `book_index_state.status='unsupported'`.
- [ ] First question on a large un-indexed book → hint shows, answer arrives ungrounded,
      second question is grounded.
- [ ] Delete book → no rows remain in `book_chunks`/`book_chunks_fts`/`book_index_state`.
- [ ] Replace a book file (re-import same id path if supported, else simulate hash
      change in test) → index rebuilds.
- [ ] Both `en.json` and `zh.json` updated; no hardcoded strings.
