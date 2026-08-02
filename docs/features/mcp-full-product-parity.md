# MCP Full Product Parity

**Status:** User-aligned implementation candidate awaiting selection evaluation. It records the agreed product direction; it is neither a frozen final count nor a claim that every tool is implemented.

## Decision

Lantern MCP is the complete external control surface for shipped Lantern capabilities. Every shipped capability is discoverable and callable by default. Lantern does not hide capabilities behind an `enable_toolset` step, does not expose a generic `execute_lantern_action`, and does not use tool descriptions to teach a workflow.

Tool count is an output, never a KPI. The previous exactly-48 catalog is withdrawn because several broad `manage_*` tools mixed ordinary operations with permanent deletion or mixed free/local work with requests that may incur API charges. The user has agreed to the direction represented by this **67-tool implementation candidate across 15 product domains**: all shipped capabilities remain available, while closely related ordinary actions are consolidated and risk boundaries remain explicit.

The number 67 is an inventory checksum for this candidate, not a ceiling, target, or final quality claim. A tool may split or merge when product behavior, task-selection evaluation, or safety evidence supports the change. Product parity must not be reduced to improve the count.

## Design rules

| Rule | Product consequence |
| --- | --- |
| Full availability | `tools/list` exposes the complete catalog to every authorized client. Domain grouping is presentation and evaluation metadata only. |
| User actions, not backend commands | A tool represents a recognizable Lantern action. Tauri commands, UI buttons, field setters, and persistence helpers are implementation details. |
| Reasonable consolidation | Single and batch variants share one tool. Search, filters, sort, pagination, and counts share one query. Ordinary create/update operations on the same object may share a discriminated action schema. |
| Risk-boundary separation | Permanent deletion has a dedicated tool. A potentially billable action does not share a tool with a local/free substitute when the actions can be named separately. |
| Exact confirmation | Confirmation occurs only for a resolved potentially billable API call or a dangerous irreversible operation. Reads, ordinary writes, local processing, and reproducible-cache removal execute directly. |
| Factual descriptions | Descriptions state the object, effect, scope, and constraints. They do not prescribe when, why, or in what order a client should use tools. |
| No server-side discovery ritual | There is no list/enable meta-tool and no request side effect that changes the advertised catalog. Capable clients may apply deferred tool loading on their side. |
| No generic executor | The internal app bridge accepts only compile-time allowlisted actions and is never exposed as a model-facing catch-all tool. |

## Audit baseline

This inventory was refreshed on 2026-08-02 in the isolated MCP worktree at commit `e43b6838b3c420d64f1c6f5536b7bd1d45d6ded2`, after fetching `origin/main` at `f4f3cff34eae3d223cd9eb8ad94d5c7be321b370`.

| Evidence | Observed state | Meaning |
| --- | --- | --- |
| Shipped product command inventory | 183 Tauri commands inherited from the app baseline | Completeness input, not a required public tool count. |
| MCP approval bridge added in the upgrade worktree | 4 Tauri commands | Internal approval UI transport; not independent product tools. |
| Current isolated registration total | 187 Tauri commands | All groups are accounted for in the coverage audit below. |
| Static frontend calls in the isolated worktree | 157 distinct literal `invoke` names, plus frontend-only reader/window actions | Frontend calls are evidence of shipped outcomes, not one-to-one tool requirements. |
| Previous product proposal | Exactly 48 tools | Withdrawn as a count-shaped design with overly broad risk boundaries. |
| Current implementation candidate | 67 tools | Exact names below; selection evaluation may still justify documented splits or merges. |

## External design basis

The 2026-07-28 review found no official MCP maximum tool count and no style guide that can certify a catalog from its count alone. The relevant guidance supports a complete static product surface, clear goal-oriented names and schemas, and task-level evaluation.

| Evidence | Catalog consequence |
| --- | --- |
| [MCP tools specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | `tools/list` is deterministic and paginated; the specification sets no catalog-size limit. Lantern cannot use request side effects to mutate what the connection advertises. |
| [MCP client best practices, 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices) | Clients own presentation, approval UX, and optional deferred discovery. Lantern keeps capabilities available rather than requiring a server-specific discovery ritual. |
| [GitHub MCP Server](https://github.com/github/github-mcp-server) and its [dynamic-toolset removal](https://github.com/github/github-mcp-server/pull/2512) | A large real catalog can be valid, but GitHub's list/enable meta-tool experiment was removed as unreliable and complex. Lantern therefore has no `enable_toolset` tool. |
| [GitHub pull-request read consolidation](https://github.com/github/github-mcp-server/issues/1247) | Closely related reads and single/batch variants should share a bounded action schema instead of mirroring endpoints one-to-one. |
| [OpenAI tool search guidance](https://developers.openai.com/api/docs/guides/tools-tool-search) | Deferred loading belongs to capable hosts/models. Its namespace-size guidance is a selection heuristic, not an MCP server limit or permission to hide Lantern features. |
| [Anthropic tool-use concepts](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/tool-use-concepts.md) | Specific names, discriminative factual descriptions, enums, required-field discipline, and evals matter more than minimizing the raw count. |
| [MCP evaluation pattern](https://github.com/lastmile-ai/mcp-eval) | Product quality must be measured with outcome, selection, path, latency, and token evidence; protocol conformance alone cannot validate tool granularity. |

Official MCP grouping remains experimental rather than a portability baseline. Lantern records domains in documentation/tests, returns the full catalog, and lets capable clients optimize how definitions enter model context.

## Why actions share or do not share a tool

Actions share a tool when they have the same product object, compatible targeting and result models, and the same confirmation class. They remain separate when a different name materially improves intent selection, when paid/local routes are distinct product actions, or when permanent deletion would otherwise make an ordinary tool appear destructive.

| Shipped actions | Catalog decision | Reason |
| --- | --- | --- |
| Search one or all collections with filters and pagination | One query tool | Scope and pagination are parameters, not separate goals. |
| Import one book or a bounded batch | One import tool | Item count does not change intent or result semantics. |
| List/search books, inspect one book, or diagnose its file state | One book-query tool | These are read-only views of the same book object and return the same identity/state model. |
| Create, rename, reorder, or change collection membership | One ordinary update tool | Same collection model, no high-risk effect, discriminated actions remain compact. |
| Permanently delete a collection | Separate delete tool | Irreversible user organization data must have an exact confirmation boundary. |
| Create or edit an annotation | One save tool | Same durable object and result model. |
| Permanently delete annotations | Separate delete tool | Exact destructive scope must not be inferred from an ordinary save contract. |
| Local dictionary lookup | Separate free tool | It must never acquire a paid confirmation because an AI action shares its schema. |
| Open/focus/resize/navigate/configure a live reader | One reader-control tool | Same live reader target, ordinary effect, and resulting reader state. |
| Inspect structure/ranges or lexically search prepared content | One book-content query tool | Same read-only content source and stable-location result model. |
| Persist a lookup-history record | Internal part of the lookup action | The app does not expose manual history fabrication as a user goal. |
| AI lookup, explanation, translation, learning card, custom action | One AI reading tool | Same routed-generation request model and paid-potential boundary. |
| Standard dictionary/Edge speech and configured custom-provider speech | Separate tools | The former is known non-billable; the latter may incur provider charges. |
| List/add/replace/enable/reorder credentials | Metadata returned by the service query; ordinary changes in one credential update tool | Same credential object; plaintext stored secrets are never returned. |
| Permanently delete a credential | Separate delete tool | Destructive credential removal has an exact target and confirmation. |
| Change AI profiles or embedding configuration | One AI-service update tool | Both are ordinary configuration of the same routed AI service surface. |
| Test a profile, credential, or embedding route | One AI-service test tool | Same connectivity/capability outcome and potentially billable boundary. |
| Rebuild a local index or manually edit stored summaries | One book-intelligence update tool | Both are non-billable edits of the same book-intelligence state. |
| OCR runtime install/cancel/uninstall | One runtime update tool | One reproducible runtime lifecycle; none is dangerous primary-data deletion. |
| OCR start/cancel/retry and reproducible OCR-asset removal | One book-OCR control tool | One local job/asset state model; no paid or primary-data risk. |

## Current implementation candidate

Confirmation values in the tables mean:

- **No:** execute directly after normal MCP authorization/write-access checks.
- **Paid only:** confirm only after Lantern resolves a route that may charge or whose cost is unknown. A confirmed free/local route is not required.
- **Permanent:** confirm the exact irreversible target and scope.
- **Conditional permanent:** safe modes execute directly; only an explicitly destructive mode is confirmed.

### 1. Library and collections: 8 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_books` | List/search/filter/sort/paginate/count books or return one book's complete user-visible metadata, reading state, format, file/preparation/cover state, availability diagnosis, and relevant counts through a discriminated query. | No |
| `import_books` | Import one or a bounded batch of supported local files and return a per-file result, including platform-supported conversions. | No |
| `update_books` | Update metadata, cover, status, progress, locator, and unread/reading/finished state for one or a bounded batch. | No |
| `prepare_book_files` | Request cloud download or retry local text preparation/conversion for one or a bounded batch, returning the resulting file/preparation state. | No |
| `delete_books` | Permanently delete one or a bounded batch with the app's note-preservation choice. | Permanent |
| `query_collections` | List/search/sort collections or list/paginate books in one collection. | No |
| `update_collections` | Create, rename, reorder, or add/remove one or many members through a discriminated action. | No |
| `delete_collections` | Permanently delete one or a bounded batch of collections without deleting their books. | Permanent |

### 2. Content and live reader: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_reader_context` | List open readers or return the focused/explicit reader's window, book, chapter, page, progress, visible passage, selection, active panel, playback, and task state. | No |
| `control_reader` | Open, close, focus, or resize a normal/standalone reader; turn pages or navigate to a stable target; or change live layout, zoom, theme, brightness, typography, spacing, margins, columns, panel size, page behavior, and per-book reader preferences through a discriminated action. | No |
| `query_book_content` | Return TOC/section structure, bounded content by section/locator/page/range, or lexical-search excerpts with stable source locations through a discriminated query. | No |

Live tools default to the focused reader. They accept an explicit stable `window_id` and return an ambiguity result instead of selecting an arbitrary window when no focus can be established.

### 3. Bookmarks, highlights, and notes: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_annotations` | List, search where supported, filter, paginate, inspect, or return export content for bookmarks, highlights, and first-class notes. It never writes an export destination. | No |
| `save_annotations` | Create bookmarks with optional labels. Create or update highlights and first-class notes, including highlight color/note text, note content, and atomic highlight-range replacement. | No |
| `delete_annotations` | Permanently delete one or a bounded batch of bookmarks, highlights, or notes. | Permanent |

### 4. Vocabulary and review: 5 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_vocabulary` | List/search/filter/paginate entries, test existence, return details/statistics, and list due reviews with definition, context, source, mastery, and FSRS state. | No |
| `save_vocabulary` | Create/edit one or many entries, set mastery, and record bounded FSRS review results through discriminated actions. | No |
| `delete_vocabulary` | Permanently delete one or a bounded batch of entries and their review state. | Permanent |
| `export_vocabulary` | Return JSON/CSV content or write it to a new explicit destination. | No; overwriting an existing destination is conditional permanent. |
| `import_vocabulary` | Preview or execute a bounded JSON/CSV import with explicit skip, merge, or overwrite conflict policy and per-item results. | Conditional permanent: only destructive overwrite of existing records. |

### 5. Lookup history: 2 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_lookup_history` | List/search/filter/paginate history and return cached lookup results. | No |
| `delete_lookup_history` | Permanently delete selected records, clear one book/all history, or prune records by a bounded retention cutoff. | Permanent |

### 6. Word forms and reader word marks: 7 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_word_forms` | List/search word-form sets or return one set. | No |
| `save_word_forms` | Create or replace an explicitly supplied word-form set. | No |
| `generate_word_forms` | Generate a word-form set with the configured AI route. | Paid only |
| `delete_word_forms` | Permanently delete one or a bounded batch of stored word-form sets. | Permanent |
| `query_word_marks` | List/filter whole-book rules, enablement, exceptions, and occurrence marks. | No |
| `update_word_marks` | Create or change rules, enablement, exceptions, occurrence marks, and scope for one or many targets. | No |
| `clear_word_marks` | Permanently clear a book's stored word-mark state in the requested scope. | Permanent |

### 7. Chats and AI reading actions: 8 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `query_chats` | List/search/filter/sort chats or return one chat with messages, scopes, sources, citations, grounding, and failure state. | No |
| `save_chats` | Create one or many chats or rename existing chats. Message persistence remains internal to the chat request. | No |
| `delete_chats` | Permanently delete one or a bounded batch of chats and their messages. | Permanent |
| `chat_with_book` | Send, quote, or retry a chat message with selection, section, book, or automatic scope and bounded source passages. | Paid only |
| `lookup_dictionary` | Run the shipped local dictionary gloss action on a word or phrase. | No |
| `run_ai_reading_action` | Run AI lookup, explanation, translation, learning-card, or configured custom action on a bounded word, phrase, passage, or source range. | Paid only |
| `generate_ai_material` | Generate a vocabulary gloss, optimized custom prompt, or chat title through configured routing. | Paid only |
| `control_ai_tasks` | Inspect tracked pending/completed/cancelled/failed AI requests or cancel one without creating another provider request. | No |

### 8. Book intelligence: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_book_intelligence` | Return preparation, lexical-index, embedding, overview, and section-summary state/details. | No |
| `update_book_intelligence` | Build, update, or force-rebuild the local lexical index, or edit an existing overview/section summary with explicitly supplied text through a discriminated action. | No |
| `generate_book_intelligence` | Generate/update embeddings, overviews, or section summaries, including full preparation and regeneration actions. | Paid only; also permanent confirmation when explicitly overwriting user-edited summaries. |

### 9. AI services, credentials, OAuth, and embeddings: 7 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_ai_services` | Return active/all profiles, health, cooldown, routing priority, models, reasoning options, embedding configuration, and credential metadata/readiness without plaintext secrets. | No |
| `update_ai_services` | Create, duplicate, edit, enable/disable, reorder, or forget learned option hints for provider profiles; enable/disable vector retrieval or change validated embedding configuration through a discriminated action. | No |
| `delete_ai_services` | Permanently delete one or a bounded batch of provider profiles. | Permanent |
| `update_ai_credentials` | Add, replace, enable/disable, or reorder credentials; stored plaintext is never returned. | No |
| `delete_ai_credentials` | Permanently delete one or a bounded batch of stored credentials. | Permanent |
| `control_openai_oauth` | Inspect status, start login, or log out through a discriminated action. | No |
| `test_ai_service` | Test an explicit profile, credential, or embedding route and report the exact endpoint/model result. | Paid only |

### 10. OCR: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_ocr_state` | Return optional runtime state, one book job/progress/error state, and local/all-device reproducible asset inventory. | No |
| `update_ocr_runtime` | Install, cancel installation, or uninstall the optional desktop OCR runtime. | No |
| `control_book_ocr` | Start, cancel, or retry a book OCR job, or remove selected local/all-device reproducible OCR assets. | No |

OCR tools remain listed on unsupported platforms and return a factual `unsupported_on_platform` result. Removing OCR assets is cache removal because the source book remains and the assets can be regenerated; it is not treated as permanent deletion of primary user data.

### 11. Speech: 4 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_speech_state` | Return source/accent/rate, models, voices, learned options, custom-key readiness, cache statistics, and live playback state. | No |
| `control_speech` | Request known non-billable dictionary/Edge audio or start, pause, resume, and stop live/system-voice playback with reading highlight state. | No |
| `request_custom_speech_audio` | Request audio from the configured custom speech provider. | Paid only |
| `configure_speech` | Change source, accent, voice, rate, model, endpoint, custom key, and learned options, or clear reproducible speech cache. | No |

### 12. Settings, custom fonts, and book sources: 4 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_settings` | Read every ordinary user-visible global/per-book setting plus managed-font and book-source lists through validated structured schemas; secrets are excluded. | No |
| `update_settings` | Atomically change ordinary global/per-book settings including language, appearance, reader defaults, interactions, bindings, learning cards, custom modules/actions, markers, history retention, and spoiler behavior. | No |
| `update_custom_fonts` | Import one or many managed reader font copies or remove managed copies and report affected preferences. | No |
| `update_book_sources` | Add, edit, enable/disable, reorder, delete, or restore default book-source configuration entries. | No |

Removing a managed font copy, deleting a reconstructible source configuration, resetting a setting, or clearing a reproducible cache is an ordinary configuration action, not dangerous irreversible deletion.

### 13. Language profile: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_language_profile` | Return manual/combined profile, assessment evidence/history, or a non-persisting CEFR estimate for supplied evidence. | No |
| `update_language_profile` | Save exam evidence, set manual level, and change explanation/translation behavior. | No |
| `delete_language_assessments` | Permanently delete one or a bounded batch of saved assessments. | Permanent |

### 14. Sync: 3 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_sync_status` | Return enabled/available state, shared folder, device identity, peers, pending work, progress, last replay, and failures. | No |
| `control_sync` | Choose/change the shared folder, enable/disable sync, start/cancel replay, or compact logs through an exact tagged action. | No |
| `remove_sync_peers` | Permanently remove one or a bounded batch of peer log/snapshot/manifest sets. | Permanent |

Sync enable/disable/folder transitions execute only after required local files are reachable. That data-safety invariant is validation, not an extra user confirmation category.

### 15. App, diagnostics, and MCP integration: 4 tools

| Tool | Supported actions and result boundary | Confirmation |
| --- | --- | --- |
| `get_app_info` | Return build/version/platform/repository information or bounded diagnostics/log information visible in Lantern. | No |
| `control_app` | Navigate/focus library, saved-material views, settings sections, chats, and readers, or change/reset app-window zoom. | No |
| `get_mcp_integration` | Return integration/configuration status and supported client configuration snippets. | No |
| `update_mcp_integration` | Enable/disable supported client registrations or change MCP write access. | No |

## Count summary

| Product domain | Tools |
| --- | ---: |
| Library and collections | 8 |
| Content and live reader | 3 |
| Bookmarks, highlights, and notes | 3 |
| Vocabulary and review | 5 |
| Lookup history | 2 |
| Word forms and reader word marks | 7 |
| Chats and AI reading actions | 8 |
| Book intelligence | 3 |
| AI services, credentials, OAuth, and embeddings | 7 |
| OCR | 3 |
| Speech | 4 |
| Settings, custom fonts, and book sources | 4 |
| Language profile | 3 |
| Sync | 3 |
| App, diagnostics, and MCP integration | 4 |
| **Current candidate total** | **67** |

The count summary is an audit checksum. It is not an optimization target.

## Canonical name list

For this implementation-candidate checkpoint, the catalog contract test uses this exact set; selection evaluation may change the document and test together. Order in `tools/list` is deterministic but has no workflow meaning.

```text
query_books
import_books
update_books
prepare_book_files
delete_books
query_collections
update_collections
delete_collections
get_reader_context
control_reader
query_book_content
query_annotations
save_annotations
delete_annotations
query_vocabulary
save_vocabulary
delete_vocabulary
export_vocabulary
import_vocabulary
query_lookup_history
delete_lookup_history
query_word_forms
save_word_forms
generate_word_forms
delete_word_forms
query_word_marks
update_word_marks
clear_word_marks
query_chats
save_chats
delete_chats
chat_with_book
lookup_dictionary
run_ai_reading_action
generate_ai_material
control_ai_tasks
get_book_intelligence
update_book_intelligence
generate_book_intelligence
get_ai_services
update_ai_services
delete_ai_services
update_ai_credentials
delete_ai_credentials
control_openai_oauth
test_ai_service
get_ocr_state
update_ocr_runtime
control_book_ocr
get_speech_state
control_speech
request_custom_speech_audio
configure_speech
get_settings
update_settings
update_custom_fonts
update_book_sources
get_language_profile
update_language_profile
delete_language_assessments
get_sync_status
control_sync
remove_sync_peers
get_app_info
control_app
get_mcp_integration
update_mcp_integration
```

## Shipped product inventory and parity path

Every shipped outcome resolves to one or more named tools below or is explicitly internal plumbing exercised through a user-action tool.

| Shipped inventory item | Product evidence | MCP path |
| --- | --- | --- |
| Library list/search/filter/count/pagination | `list_books`, `get_book_counts`, Home library views | `query_books` |
| Complete book detail | `get_book`, book rows/context menus | `query_books` |
| File picker, drag/drop, OS-open and batch import | `import_book_from_dialog`, `import_external_paths`, Home drop handling | `import_books` |
| Title, author, genre, cover, status edits | metadata/cover/status commands and context menus | `update_books` |
| Progress, locator, unread/reading/finished | progress/status/finished commands and reader progress writer | `update_books` |
| Derived page-count persistence | `update_book_pages`, reader page calculation | Internal reader persistence reflected by `query_books` |
| File presence, cloud request, open-failure diagnosis | availability/diagnosis commands and reader diagnosis | `query_books`, `prepare_book_files` |
| Text preparation and format conversion state/retry | text/converted-path and retry commands | `query_books`, `prepare_book_files`, `query_book_content` |
| Book deletion with note policy | `delete_book`, delete dialog | `delete_books` |
| Collection list/search/contained books | collection list/books commands and sidebar | `query_collections` |
| Collection create/rename/reorder/membership | six ordinary collection mutation commands | `update_collections` |
| Collection deletion | `delete_collection` | `delete_collections` |
| Normal/standalone reader open/focus/close/size | reader window utilities and persistence | `get_reader_context`, `control_reader` |
| Active chapter/page/progress/visible text/selection/panel | Reader and foliate/text-reader callbacks | `get_reader_context` |
| Page/chapter/CFI/bookmark/highlight/note/vocabulary/source/citation navigation | reader navigation, TOC, citation navigation | `control_reader`, `query_book_content` |
| Reader theme/brightness/font/layout/columns/margins/zoom/progress display/page bindings/panel width | Reader settings, per-book sync, panel resize | `control_reader`, `get_settings`, `update_settings` |
| Prepared content, TOC, sections, ranges, locations | text document and reader structures | `query_book_content` |
| Lexical content search and source locations | current MCP content search and prepared documents | `query_book_content` |
| Bookmark create/list/delete and labels | bookmark commands and panel | `query_annotations`, `save_annotations`, `delete_annotations` |
| Highlight create/list/range replace/color/note/delete | highlight commands and toolbar | `query_annotations`, `save_annotations`, `delete_annotations` |
| First-class note create/edit/list/search/filter/context/delete | note commands, Notes view, learning cards | `query_annotations`, `save_annotations`, `delete_annotations` |
| Notes CSV export content and source navigation | Notes export/locate controls | `query_annotations`, `control_reader` |
| Vocabulary CRUD/existence/all-book filters/detail | vocabulary commands and Dictionary view | `query_vocabulary`, `save_vocabulary`, `delete_vocabulary` |
| Mastery bulk/single, FSRS due/review/statistics | mastery/review/due/stats commands | `query_vocabulary`, `save_vocabulary` |
| Vocabulary JSON/CSV export, preview, import/conflicts | backup commands and UI | `export_vocabulary`, `import_vocabulary` |
| Lookup cache/list/delete/clear/prune/retention | history commands and General settings | `query_lookup_history`, `delete_lookup_history`, `update_settings` |
| Lookup record persistence | `save_lookup_record`, reading-action hooks | Internal implementation of `lookup_dictionary` and `run_ai_reading_action` |
| Word-form list/get/save/generation/deletion | word-form commands and manager | `query_word_forms`, `save_word_forms`, `generate_word_forms`, `delete_word_forms` |
| Whole-book rules, enablement, exceptions, occurrences, clear | word-mark commands and reader controls | `query_word_marks`, `update_word_marks`, `clear_word_marks` |
| Chat list/search/filter/sort/get/create/rename/delete | chat commands and saved chat views | `query_chats`, `save_chats`, `delete_chats` |
| Chat send/scopes/quotes/source passages/grounding/retry | `ai_chat`, chat hook, messages/citations | `chat_with_book`, `query_chats` |
| Message persistence/replacement | `save_chat_message`, `replace_chat_message` | Internal implementation of `chat_with_book` |
| Local dictionary gloss | `dictionary_gloss`, reader popover | `lookup_dictionary` |
| AI lookup/explain/translate/learning card/custom action | AI/translation commands and reader popovers | `run_ai_reading_action` |
| Vocabulary gloss/prompt optimization/chat title | AI generation commands and editor flows | `generate_ai_material` |
| Cancel and inspect tracked AI work | `ai_cancel`, streaming UI state | `control_ai_tasks` |
| Book AI state/index details/overview | state/detail/read commands | `get_book_intelligence` |
| Local lexical index build/update/force rebuild | `ai_reindex_book`, local index path | `update_book_intelligence` |
| Manual overview/section summary edits | two summary update commands | `update_book_intelligence` |
| Embeddings and summary preparation/update/regeneration | `ai_prepare_book`, `ai_update_book_index`, `ai_regenerate_book_summaries` | `generate_book_intelligence` |
| AI profiles active/list/create/duplicate/edit/enable/reorder/delete | AI settings commands/UI | `get_ai_services`, `update_ai_services`, `delete_ai_services` |
| Models, reasoning options, health, cooldown, tests | model/effort/test commands and router health | `get_ai_services`, `update_ai_services`, `test_ai_service` |
| Credential metadata/add/replace/enable/reorder/delete and legacy key | credential/key commands and cards | `get_ai_services`, `update_ai_credentials`, `delete_ai_credentials` |
| OAuth login/status/logout | OAuth commands | `control_openai_oauth` |
| Vector retrieval status/enable/probe | embedding/vector commands | `get_ai_services`, `update_ai_services`, `test_ai_service` |
| OCR runtime status/download/cancel/uninstall | package commands and settings | `get_ocr_state`, `update_ocr_runtime` |
| OCR job start/cancel/retry/status/progress | manager commands and reader HUD | `get_ocr_state`, `control_book_ocr` |
| OCR asset overview/local/all-device removal | asset commands and settings | `get_ocr_state`, `control_book_ocr` |
| Dictionary/Edge/custom audio and system-voice playback | speech commands, speech hook/player | `get_speech_state`, `control_speech`, `request_custom_speech_audio` |
| Speech models/voices/source/accent/rate/key/learned options | speech commands/settings | `get_speech_state`, `configure_speech` |
| Playback start/pause/resume/stop and highlighting | playback store/bar and reader | `get_speech_state`, `control_speech` |
| Speech cache stats/clear | cache commands | `get_speech_state`, `configure_speech` |
| Global/per-book ordinary settings | setting commands and settings panels | `get_settings`, `update_settings` |
| Language/name/theme/reader defaults/learning tools/actions/bindings/markers/history/spoiler | General/Appearance/Reading/Tools panels | `get_settings`, `update_settings` |
| Custom font list/import/delete | font commands and Reading settings | `get_settings`, `update_custom_fonts` |
| Book-source list/add/edit/enable/reorder/delete/default restore | Book Sources structured setting | `get_settings`, `update_book_sources` |
| CEFR estimate/manual level/history/combined evidence/delete and language behavior | assessment commands and General settings | `get_language_profile`, `update_language_profile`, `delete_language_assessments` |
| Sync status/folder/enable/disable/progress/now/cancel/compact | sync commands and Sync settings | `get_sync_status`, `control_sync` |
| Sync peer list/removal | sync status/remove command | `get_sync_status`, `remove_sync_peers` |
| Build/version/repository and bounded diagnostics/logs | app commands, About, reader diagnostics | `get_app_info` |
| Library/settings/saved-material/reader navigation and app zoom | app open commands, routes, zoom service | `control_app` |
| MCP client registration/config snippet/write access | MCP commands and settings | `get_mcp_integration`, `update_mcp_integration` |
| MCP pending-approval list/read/approve/reject | four upgrade-worktree commands and global approval dialog | Internal exact-approval transport, never public MCP tools |
| App readiness and frontend warning ingestion | `app_ready`, `log_webview_warning` | Internal app plumbing, not an independent user action |

## Registered-command coverage audit

The isolated worktree registers 187 Tauri commands. The original 183 product commands and four approval-bridge commands are accounted for below. This is a completeness audit, not a proposed public API.

| Command group | Count | MCP path or internal ownership |
| --- | ---: | --- |
| `app::*` | 4 | `get_app_info`, `control_app`; readiness/log ingestion remain internal. |
| `books::*` | 17 | Library, file-maintenance, and content tools. |
| `ocr::package::*` | 4 | `get_ocr_state`, `update_ocr_runtime`. |
| `ocr::manager::*` | 6 | `get_ocr_state`, `control_book_ocr`. |
| `ai::*` | 19 | Chat/reading generation, AI tasks, and book-intelligence tools. |
| `settings::*` | 33 | Structured settings, AI services/credentials/embeddings, speech, and app control. |
| `fonts::*` | 3 | `get_settings`, `update_custom_fonts`. |
| `dictionary::*` | 1 | `lookup_dictionary`. |
| `speech::*` | 10 | Four speech tools. |
| `language_assessments::*` | 5 | Three language-profile tools. |
| `bookmarks::*` | 9 | Three annotation tools. |
| `notes::*` | 4 | Three annotation tools; CSV output is frontend-derived. |
| `word_marks::*` | 14 | Word-form and word-mark tools. |
| `collections::*` | 8 | Three collection tools. |
| `oauth::*` | 3 | `control_openai_oauth`. |
| `vocab::*` | 14 | Five vocabulary tools. |
| `lookup_history::*` | 7 | Two lookup-history tools plus internal reading-action persistence. |
| `chats::*` | 9 | Chat tools plus persistence behind `chat_with_book`. |
| `translation::*` | 1 | `run_ai_reading_action`. |
| `mcp::*` | 8 | Four integration commands map to two public tools; four exact-approval commands remain internal. |
| `sync::*` | 8 | Three sync tools. |
| **Total** | **187** | **No registered command group is omitted.** |

## Confirmation policy

Confirmation is based on the concrete resolved effect, never merely on a broad tool annotation.

Confirmation is required only when:

1. Lantern is ready to send a request to a paid or unknown-cost API.
2. Lantern is ready to perform a dangerous irreversible operation, principally permanent deletion of primary user data or an explicitly destructive bulk overwrite.

All such capabilities remain callable. Confirmation pauses only the exact pending action and binds to the complete arguments, resolved service/model/route, target IDs, item count, scope, and relevant preservation/overwrite policy. An approval is one-time and cannot authorize a replay or a wider batch.

No confirmation is required for reads, searches, navigation, ordinary edits/settings, local indexing/conversion/OCR, cancellation, retry that cannot incur a new charge, reproducible cache/runtime removal, managed font-copy removal, reconstructible source configuration, or data-safe sync enable/disable/folder changes.

Paid confirmation states the action, resolved provider/model, maximum request count and bounded input scope, plus a cost estimate/upper bound when calculable; otherwise it states factually that the provider may charge. Permanent confirmation states exact object type, IDs/count, scope, preservation/overwrite policy, and consequence. Neither message recommends whether the user should proceed.

## Capabilities that are not shipped

These are not parity gaps and do not enter the catalog until the corresponding Lantern product capability ships.

| Capability | Evidence/status |
| --- | --- |
| In-app update check/download/apply | `PlatformCapabilities.hasUpdater` has no consumer; dormant strings do not constitute a shipped updater. |
| Collection folders | A feature document exists, but no shipped model or UI exists. |
| Full library backup/restore/reset | No shipped app workflow or registered commands exist. |
| Reading statistics | No shipped reading-statistics surface exists; vocabulary review statistics are included. |
| Persisted explanation records | Explanations are transient unless represented in chat/history/note data. |
| AI-assisted note threads | First-class notes ship; note threads do not. |
| Generic cloud-data deletion | Only concrete sync-peer and all-device reproducible OCR-asset behaviors ship. |

Mobile/desktop differences are structured runtime capability results, not different tool catalogs. MCP integration itself currently ships on desktop only.

## Implementation constraints

- `tools/list` returns the complete canonical set deterministically and supports protocol pagination without hiding domains by default.
- Tool names use stable lower-snake-case. Descriptions state facts and boundaries without workflow advice.
- Tagged actions use discriminated unions; unrelated fields are rejected rather than ignored.
- Single/batch operations share one bounded item-array schema and return per-item success/error results for partial failures.
- Query tools use explicit filters, stable sorting, cursors/limits, and bounded content sizes.
- High-risk gates run after routing and capability resolution but before any billable request or irreversible mutation.
- Approval records bind action, exact normalized arguments, route, scope, and expiry; approve/reject is one-time and replay-safe.
- Credential responses expose metadata/configured state only and never return stored plaintext secrets.
- Long-running operations return task identity and make pending/completed/cancelled/failed/unavailable state observable through the owning tool.
- Live reader, playback, OAuth, picker, navigation, and app-state actions use an authenticated local app bridge because the stdio process does not own Tauri runtime state.
- The bridge has a compile-time allowlist, authentication bound to the active app/data directory, bounded waits, stale-app handling, expiry/cancellation cleanup, and no model-visible secret. It is not a public generic action tool.
- Unsupported-platform results are factual and structured; the corresponding tools remain discoverable.
- Every action declares factual read/write, local/network, paid-potential, destructive-potential, and idempotency metadata for clients and tests.

## Acceptance criteria

### Catalog and schemas

- For this implementation-candidate checkpoint, `tools/list` contains exactly the 67 canonical names in this document: no missing, unexpected, duplicate, deprecated, single/batch, field-level, endpoint-shaped, `enable_toolset`, or generic executor aliases. A later selection-evaluation change updates this document and the catalog test together rather than preserving 67 as a KPI.
- Protocol pagination is deterministic and reconstructs the same complete set without connection-specific or request-side-effect mutations.
- Schema tests exercise every supported action and reject unknown actions, unrelated fields, unbounded arrays, invalid IDs, invalid cursors, and oversized content.
- Tool descriptions state object/effect/scope/boundary and contain no prescribed workflow, recommended sequence, or instruction to enable another tool.

### Product parity

- Every shipped-inventory row above has an integration, contract, or bridge test proving its named MCP path.
- All 187 current registered commands remain accounted for, including internal persistence, app-plumbing, and approval-bridge commands.
- Frontend-only reader/window/playback/navigation actions have bridge tests with the app absent, one reader, multiple readers, focused target, explicit `window_id`, and ambiguous focus.
- Unsupported-platform tests prove tools remain listed and return structured capability results.

### Confirmation behavior

- Every potentially billable tool is tested with a known local/free route, a known paid route, and an unknown-cost route; no provider request begins before exact approval for the latter two.
- Free/local routes, ordinary reads/writes, local OCR/index/conversion, cache removal, cancellations, and retries that cannot create a charge execute without confirmation.
- Every permanent-delete tool proves exact type/IDs/count/scope/policy binding, reject behavior, one-time consumption, expiry, and replay prevention.
- Conditional destructive modes prove safe preview/skip/merge/new-file paths do not prompt while explicit overwrite paths do.
- Batch approval cannot authorize additional items, a different model/provider, a different destination, or a second execution.

### Selection quality

- A catalog evaluation covers all 15 domains, multi-step tasks, near-neighbor tools, destructive/non-destructive pairs, paid/free pairs, and negative prompts where no tool should run.
- Evaluation reports first-tool accuracy, task completion, unnecessary calls, schema errors, confirmation correctness, tokens, and latency.
- The 67-tool implementation candidate is not accepted as final merely because tests can enumerate it: confused clusters are split or merged based on task evidence, with this document and the canonical catalog test changed together.

### Full verification

- MCP library tests, stdio binary tests, Rust checks, frontend typecheck/lint/unit tests, and diff checks pass for the completed implementation.
- Current, pending, completed, cancelled, failed, unavailable, expired, rejected, and partially completed states are observable wherever Lantern exposes them.
- The implementation branch is committed and pushed only after the full parity and confirmation audit passes.

## Resolved product choices

- Every shipped capability is discoverable and callable by default.
- The catalog is grouped for human review and evaluation, not hidden behind server-side toolsets.
- Tool count is an audit checksum, not a quality score.
- Single/batch, filtering/pagination, field-level edits, and internal persistence remain consolidated where intent and risk match.
- Ordinary operations and permanent deletion use different tool names.
- Known non-billable/local actions and potentially billable actions use different tool names where Lantern can expose that distinction before routing.
- Exact resolved paid or irreversible effects are confirmed; ordinary use is not.
- Focused reader is the default live target; explicit `window_id` resolves multi-window targeting.
- Local/reproducible cache, OCR asset, optional runtime, managed font-copy, and reconstructible source-configuration removal is not dangerous primary-data deletion.
- Dormant updater strings do not constitute a shipped updater.

**The user-aligned direction is sufficient to continue implementation, but the catalog is not frozen before selection evaluation.** Remaining unknowns are implementation and evaluation findings: bridge transport mechanics, platform adapters, exact fixtures, and whether measured tool-selection confusion justifies a documented split or merge.
