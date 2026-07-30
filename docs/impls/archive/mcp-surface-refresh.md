# MCP Surface Refresh

**Status:** Implemented on 2026-07-15.

This refresh brings Lantern's MCP server up to date with the learning tools,
Grounded Book Chat, local index management, spoiler guard, and batch library
features introduced through v1.5.2.

## Decisions

- Keep the four single-item write tools as deprecated compatibility wrappers;
  remove them in v1.7.
- Apply the same global and per-book spoiler settings used by in-app chat to MCP
  content search and summaries. MCP exposes no bypass parameter.
- Expose CEFR language assessments read-only as `get_language_profile`.
- Require an explicit write-gated `request_book_index`; read tools never build
  an index implicitly.
- Keep embeddings and all model-calling paths outside MCP. Book search uses FTS
  only, and summary tools only read summaries generated in the app.

## Delivered Surface

The server retains the existing library, reading-data, vocabulary, chat, and
collection tools and adds:

- Batch library/collection tools: `import_books`, `delete_books`,
  `add_books_to_collection`, `remove_books_from_collection`, and
  `get_collection_books`.
- Content tools: `search_book_content`, `get_book_summaries`,
  `get_book_index_status`, and `request_book_index`.
- Learning tools: `get_notes`, `get_lookup_history`, `get_word_marks`, and
  `get_language_profile`.
- Optional full-library and due-only modes for `get_vocab_words`.

Batch calls return per-input `ok`, `noop`, `not_found`, `unsupported`, or
`error` results and notify the desktop app once per changed domain. The legacy
single-item tools call the same internal batch paths.

## Security Boundaries

MCP responses omit cover BLOBs, device identifiers, lookup `result_json`, and
provider profile IDs. It does not expose settings, OAuth state, secrets, sync
infrastructure, AI-provider health fields, embedding tables, language-profile
writes, or any operation that can consume model quota. Internal settings reads
are limited to `mcp_write_enabled`, `ai_spoiler_guard`, and per-book spoiler
overrides.

## Verification

The MCP registry tests cover the complete tool set. Seeded tool tests cover
collection projections, FTS retrieval, spoiler filtering, summary filtering,
index details, notes, lookup-history redaction, word marks, CEFR aggregation,
batch result semantics, and write gating. The binary integration test asserts
the same registry over stdio.
