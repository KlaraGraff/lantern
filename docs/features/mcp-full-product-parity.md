# MCP: context equity

## Product boundary

Lantern MCP gives a user's own AI client the reading context that Lantern's
built-in AI can already inspect. It is not a general external control surface
for the application.

The boundary is deliberately small:

1. Reading context is always available and read-only.
2. `open_in_reader` points a result back to the source text.
3. Library and learning-data mutations require the existing `mcp_write_enabled`
   switch, which defaults to off.
4. Device and service configuration, application navigation, and making Lantern
   call an AI provider are outside MCP.

MCP never returns API keys, OAuth tokens, or other plaintext credentials.

## Tool catalog

The server lists its complete catalog in one `tools/list` response. There are
exactly 29 tools.

### Read context (11)

| Tool | Data returned |
| --- | --- |
| `query_books` | Paginated book search and filtering, or one book's user-visible metadata, reading progress, format, availability, and preparation state. |
| `query_collections` | Collections, or paginated books in one collection. |
| `query_book_content` | Table of contents, bounded source-positioned content, and lexical search results. |
| `get_book_intelligence` | Preprocessing and lexical-index state, embedding state, and saved book and chapter overviews. It never starts processing. |
| `query_annotations` | Searchable, paginated bookmarks, highlights, and first-class notes. |
| `query_vocabulary` | Vocabulary entries, due items, definitions, contexts, source locations, mastery, FSRS state, and statistics. |
| `query_lookup_history` | Searchable, paginated lookup history and cached results. |
| `query_word_forms` | Word-form sets. |
| `query_word_marks` | Whole-book rules, enabled state, exceptions, and occurrence marks. |
| `query_chats` | Chats, messages, scope, sources, citations, grounding, and failure state. |
| `get_language_profile` | Manual level, combined profile, exam evidence, and history. |

Reading progress is part of `query_books`; it is not a separate tool.

### Source action (1)

| Tool | Effect |
| --- | --- |
| `open_in_reader` | Requests that the running Lantern app open a book, optionally at a CFI/source location. It reports an unconfirmed request rather than claiming the app opened it. |

The MCP subprocess writes one `.mcp-notify` sentinel with the `open` domain.
The app watcher uses the same reader-window path as saved notes and vocabulary.
There is no MCP session, heartbeat, ownership, acknowledgement, or retry
protocol. If Lantern is not running, the request remains unconfirmed.

### Writes behind `mcp_write_enabled` (17)

| Tool | Effect |
| --- | --- |
| `import_books` | Imports a bounded list of local files and returns an item result for every path. |
| `update_books` | Updates book metadata, reading state, progress, or saved location for one or a bounded batch. |
| `delete_books` | Permanently deletes one or a bounded batch of books and their selected associated data. |
| `update_collections` | Creates, renames, reorders, and changes collection membership. |
| `delete_collections` | Permanently deletes collections without deleting their books. |
| `save_annotations` | Creates bookmarks, creates or updates highlights, and creates or updates first-class notes. |
| `delete_annotations` | Permanently deletes bookmarks, highlights, or notes. |
| `save_vocabulary` | Creates or edits vocabulary, mastery, and FSRS review results. |
| `delete_vocabulary` | Permanently deletes vocabulary and its review state. |
| `export_vocabulary` | Returns vocabulary export content. |
| `import_vocabulary` | Previews or imports bounded JSON/CSV data with `skip`, `merge`, or `overwrite` conflict handling. Merge preserves conflicting local entries and imports nonconflicting entries. |
| `save_word_forms` | Creates or replaces explicitly supplied word-form sets. |
| `delete_word_forms` | Permanently deletes word-form sets. |
| `update_word_marks` | Updates whole-book rules, enabled state, exceptions, and occurrence marks. |
| `clear_word_marks` | Permanently clears a book's word-mark state. |
| `save_chats` | Creates or renames chats without asking an AI provider. |
| `delete_chats` | Permanently deletes chats and their messages. |

Each batch accepts a bounded array and returns per-item outcomes. A write call
made while the switch is off is rejected before it can change the database.

## Confirmations

Only permanent deletion and destructive overwrite require approval:

- `delete_books`, `delete_collections`, `delete_annotations`,
  `delete_vocabulary`, `delete_word_forms`, `clear_word_marks`, and
  `delete_chats`;
- `import_vocabulary` when `mode` is `execute` and `conflict_policy` is
  `overwrite`.

An approval binds the exact tool name, full arguments, object IDs, count,
scope, and preservation or overwrite policy. It is atomically consumed, so it
cannot authorize a changed call, a larger batch, or a replay. Normal writes,
reads, previews, and cache/preparation state do not request approval.

No billing or provider-cost confirmation exists in MCP because MCP never asks
Lantern to call an AI provider.

## Explicit exclusions

MCP does not expose speech, OCR, sync, AI services or credentials, OAuth,
fonts, book sources, window or application navigation, settings, MCP settings,
or language-profile writes. It does not expose dictionary/translation/card AI,
book chat, summaries or embeddings generation, word-form AI generation, or AI
task cancellation.

## Verification contract

The server contract test asserts the exact 29 tool names. Focused tests cover
every tool schema, write-switch rejection for every write, exact one-time
approval binding for permanent deletion and destructive overwrite, and the
unconfirmed `open_in_reader` result when no app-side notify path is available.
