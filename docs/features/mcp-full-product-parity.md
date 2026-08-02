# MCP Full Product Parity

**Status:** Product catalog approved for implementation. This document defines the product surface; it does not imply that every proposed tool is implemented yet.

## Decision

Lantern MCP is the complete external control surface for shipped Lantern capabilities. All tools are discoverable by default. Lantern does not decide how a client should use them, and tool descriptions do not teach a workflow.

Tool count is an output of the product design, not a target. The catalog is divided by coherent user goals. Single-item/batch variants, field-level setters, UI buttons, and lifecycle operations on the same product object are consolidated behind discriminated actions.

The exact proposed catalog contains **48 MCP tools across 12 product domains**.

## Authoritative audit baseline

This audit was refreshed on 2026-08-02 against `origin/main` commit `0977d11d0223` and the isolated upgrade worktree.

| Evidence | Observed state | Meaning |
| --- | --- | --- |
| `src-tauri/src/lib.rs` on `origin/main` | 183 registered Tauri commands | Backend/UI commands are implementation units, not MCP tool requirements. |
| Static frontend calls on `origin/main` | 156 distinct literal `invoke` names, plus frontend-only reader/window actions | User actions do not map one-to-one to backend commands. |
| MCP router on `origin/main` | 29 registered tools | This is the current mainline baseline. |
| Isolated upgrade worktree | 57 registered tools, 6 more implemented but not registered, and stale registry tests enumerating 50 | This is an in-progress implementation state, not a product catalog. |
| Proposed product catalog | 48 tools | This is the exact full-parity design below, derived item by item. |

The shipped 29-tool surface is incomplete. The unreviewed upgrade path then grew past its 50-name test inventory to 57 registered tools because command-shaped entries kept being added while consolidation and parity work happened together. It still omits live reader control, sync, OCR, speech, AI service management, fonts, and structured settings.

The proposed surface is smaller than both in-progress counts while covering more of the product. That is a consequence of consolidating by goal, not a requirement to stay below 50.

## User actions versus MCP tools

A **user action** is an outcome Lantern exposes, such as renaming a collection, retrying OCR, or jumping to a citation. An **MCP tool** is a stable contract that can cover closely related actions through a tagged `action` or `kind` field.

Actions belong in one tool when they operate on the same product object, share the same target and result model, and can use a discriminated schema without unrelated fields becoming valid together. They remain separate when the object, targeting model, result, or long-running state is materially different.

| Shipped actions | Proposed tool | Product boundary |
| --- | --- | --- |
| Add/remove one or many collection books | `manage_collections` | One collection-membership lifecycle; item count is an argument. |
| Create/edit/review/delete vocabulary | `manage_vocabulary` | One durable vocabulary-entry lifecycle. |
| Change highlight note/color/range | `manage_annotations` | Field-level controls are not independent goals. |
| Open/close/focus/navigate/configure a reader | `control_reader` | One live reader session and target identity. |
| Install/cancel/uninstall OCR runtime | `manage_ocr_runtime` | One runtime lifecycle and state model. |
| Read settings versus change settings | `get_settings`, `update_settings` | A read-only inspection stays separate from mutation. |
| Book file lifecycle versus book metadata | `manage_book_files`, `update_books` | File availability/preparation has asynchronous state that metadata does not. |

No generic `execute_lantern_action` tool is allowed. Consolidation stops at a named product object or workflow.

## External design basis

The reviewed guidance does not define a universal tool-count limit. It consistently favors clear goal-oriented contracts, factual descriptions, bounded schemas, and discoverability that does not depend on a client guessing hidden capabilities.

- [OpenAI tool planning guidance](https://developers.openai.com/plugins/plan/tools)
- [MCP client best practices, 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Experimental MCP primitive grouping](https://github.com/modelcontextprotocol/experimental-ext-grouping)

Primitive grouping remains experimental, so Lantern does not rely on it to make capabilities reachable. The complete tool list is returned even if a client later presents it by domain.

## Exact proposed catalog

### 1. Library and collections: 7 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `find_books` | List, search, filter, sort, paginate, count, and scope books by status, genre, format, or collection. | No |
| `get_book` | Return complete user-visible metadata, reading state, format, file/preparation state, cover state, and relevant counts for one book. | No |
| `import_books` | Import one or many supported local files and return per-file results, including platform-supported conversion formats. | No |
| `update_books` | Update title, author, genre, cover, status, progress, current locator, and unread/reading/finished state for one or many books. | No |
| `manage_book_files` | Inspect normal/deep availability, diagnose open failure, request cloud download, inspect text/conversion state, and retry preparation or conversion. | No |
| `delete_books` | Permanently delete one or many books with the same note-preservation choice as the app. | Yes, irreversible data |
| `manage_collections` | List, create, rename, reorder, delete, list contained books, and add/remove one or many members through a tagged action. | Only irreversible delete |

### 2. Content and live reader: 4 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_reader_context` | List open readers and return active window, book, chapter, page, progress, visible passage, selection, active panel, playback, and task state. | No |
| `control_reader` | Open, close, focus, resize, navigate, page forward/back, or change live layout, zoom, theme, brightness, font, spacing, margins, columns, panel size, page behavior, and per-book preferences. | No |
| `inspect_book_content` | Return TOC/section structure or bounded content by section, locator, page, or range with stable source targets. | No |
| `search_book_content` | Lexically search prepared book content and return bounded excerpts with source locations. | No |

When multiple readers exist, live tools default to the focused reader and accept an explicit stable `window_id`. They return an ambiguity result rather than selecting an arbitrary reader.

### 3. Bookmarks, highlights, and notes: 2 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `query_annotations` | List, filter, paginate, inspect, and where supported search bookmarks, highlights, and first-class notes; notes can be returned as the same filtered CSV available in the app. | No |
| `manage_annotations` | Create, update, atomically replace ranges, or permanently delete bookmarks, highlights, and notes through tagged kind/action arguments. | Only irreversible delete |

### 4. Vocabulary, lookup history, and word marking: 7 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `query_vocabulary` | List/search/filter/paginate entries, test existence, return details/statistics, and list due items with definition, context, source, mastery, and FSRS state. | No |
| `manage_vocabulary` | Create/edit entries, set mastery singly or in a batch, record FSRS reviews, or permanently delete entries and review state. | Only irreversible delete |
| `transfer_vocabulary` | Export JSON/CSV, preview import, or import with explicit skip/merge/overwrite conflict policy. | Only destructive overwrite |
| `query_lookup_history` | List/search/filter/paginate history and return cached lookup results. | No |
| `manage_lookup_history` | Record, delete selected records, clear book/all history, or prune by retention period. | Only irreversible deletion/clear/prune |
| `manage_word_forms` | Read, save, generate, or permanently delete word-form sets through a tagged action. | Only paid generation or irreversible delete |
| `manage_word_marks` | List/change whole-book rules, occurrence marks, enablement, exceptions, and scope; explicitly clear a book's marks. | Only irreversible clear |

### 5. Chats and AI reading: 7 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `query_chats` | List/search/filter/sort chats or return one chat with messages, scopes, sources, citations, grounding, and failure state. | No |
| `manage_chats` | Create, rename, or permanently delete one or many chats and their messages. | Only irreversible delete |
| `chat_with_book` | Send, quote, or retry a message with selection, section, book, or automatic scope and multiple source passages. | Only when selected route may charge |
| `run_reading_action` | Run lookup, local dictionary, explanation, translation, learning-card, or configured custom action on a word, phrase, passage, or explicit source range. | Only when selected route may charge |
| `generate_ai_material` | Generate a vocabulary gloss, optimized custom prompt, or chat title using configured routing. | Only when selected route may charge |
| `manage_ai_tasks` | Inspect active/completed/cancelled/failed AI requests Lantern still tracks, or cancel an active request without creating another billable call. | No |
| `manage_book_intelligence` | Inspect preparation/index/summary state; prepare, update, or rebuild indexes; read/edit/regenerate overview and section summaries with explicit overwrite behavior. | Only paid work or destructive overwrite |

`chat_with_book` owns message persistence as part of the user goal. Internal message-save/replace commands are not independent model-facing tools.

### 6. AI services and credentials: 6 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_ai_services` | List active/all profiles, health, cooldown, routing priority, models, reasoning-effort options, and credential readiness without plaintext secrets. | No |
| `manage_ai_services` | Create, duplicate, edit, enable/disable, reorder, forget learned option hints, or permanently delete provider profiles. | Only irreversible profile delete |
| `manage_ai_credentials` | List metadata, add, replace, enable/disable, reorder, or permanently delete credentials; never export plaintext secrets. | Only irreversible credential delete |
| `manage_openai_oauth` | Start login, inspect status, or log out through a tagged action. | No |
| `manage_embeddings` | Inspect, enable/disable, or probe vector retrieval and embedding configuration. | Only a probe/request that may charge |
| `test_ai_service` | Test a profile or credential and report exact endpoint/model result. | Only when test may create billable usage |

### 7. OCR: 2 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `manage_ocr_runtime` | Inspect, install, cancel installation, or uninstall optional desktop OCR runtime. | No |
| `manage_book_ocr` | Inspect/start/cancel/retry a book OCR job, return progress/errors, list active/local assets, and delete local or all-device reproducible OCR assets. | No |

OCR tools remain listed on unsupported platforms and return a factual `unsupported_on_platform` result. Capability absence does not remove tools from discovery.

### 8. Speech: 3 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_speech_state` | Return source/accent/rate, models, voices, learned options, custom-key status, cache statistics, and live playback state. | No |
| `control_speech` | Request dictionary/Edge/custom audio or start/pause/resume/stop live playback, including system voices and live reading highlight. | Only when selected source may charge |
| `configure_speech` | Change source, accent, voice, rate, model, endpoint, custom key, or learned options; clear reproducible speech cache. | No |

### 9. Settings, fonts, and book sources: 4 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_settings` | Read every ordinary user-visible global/per-book setting through validated structured schema; secrets are excluded. | No |
| `update_settings` | Atomically change language, appearance, app zoom, reader defaults, interactions, bindings, learning cards, custom modules/actions, markers, history retention, spoiler behavior, and other ordinary global/per-book settings. | No |
| `manage_custom_fonts` | List, import, or remove locally managed reader fonts and report affected preferences. | No for managed imported copy |
| `manage_book_sources` | List, add, edit, enable/disable, reorder, delete, or restore default book-source entries. | No |

### 10. Language profile: 1 tool

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `manage_language_profile` | Read manual/combined profile and evidence; estimate CEFR, save exam evidence, set manual level, change explanation/translation behavior, or permanently delete selected assessments. | Only irreversible assessment delete |

### 11. Sync: 2 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_sync_status` | Return enabled/available state, shared folder, device identity, peers, pending work, progress, last replay, and failures. | No |
| `manage_sync` | Choose/change folder, enable/disable, start/cancel/compact work, or remove peer devices with exact progress/results. | Only a transition/removal that may make unique data unavailable or change recoverability |

### 12. App, diagnostics, and MCP integration: 3 tools

| Tool | Supported shipped outcomes | Confirmation |
| --- | --- | --- |
| `get_app_info` | Return build/version/platform/repository information or the same bounded diagnostics/log information visible in Lantern. | No |
| `control_app` | Navigate/focus library, saved-material views, settings sections, chats, and readers; change/reset app-window zoom. | No |
| `manage_mcp_integration` | Inspect configuration/status, return client snippets, enable/disable supported client registrations, and change MCP write access. | No |

## Count summary

| Domain | Tools |
| --- | ---: |
| Library and collections | 7 |
| Content and live reader | 4 |
| Bookmarks, highlights, and notes | 2 |
| Vocabulary, lookup history, and word marking | 7 |
| Chats and AI reading | 7 |
| AI services and credentials | 6 |
| OCR | 2 |
| Speech | 3 |
| Settings, fonts, and book sources | 4 |
| Language profile | 1 |
| Sync | 2 |
| App, diagnostics, and MCP integration | 3 |
| **Total** | **48** |

This count is not a ceiling. A future feature adds a tool only when it introduces a genuinely new product object, target, result, or state model. An existing tool splits only when one of those boundaries becomes materially different.

## Shipped product inventory and parity path

This is the acceptance inventory. Every shipped outcome resolves to one of the 48 tools or is explicitly internal plumbing exercised through a user-goal tool.

| Shipped inventory item | Product evidence | Proposed MCP path |
| --- | --- | --- |
| Library list/search/filter/count/pagination | `list_books`, `get_book_counts`, Home library views | `find_books` |
| Complete book detail | `get_book`, book rows/context menus | `get_book` |
| File picker, drag/drop, OS-open and batch import | `import_book_from_dialog`, `import_external_paths`, Home drop handling | `import_books` |
| Title, author, genre, cover, status edits | metadata/cover/status commands, existing MCP genre edit, context menus | `update_books` |
| Progress, locator, unread/reading/finished | progress/status/finished commands, reader progress writer | `update_books` |
| Derived page-count persistence | `update_book_pages`, reader page calculation | Internal reader implementation reflected by `get_book` |
| File presence, iCloud request, deep open-failure diagnosis | availability/diagnosis commands and reader diagnosis | `manage_book_files` |
| Text preparation and format-conversion state/retry | text/converted-path and retry commands | `manage_book_files`, `inspect_book_content` |
| Book deletion with note policy | `delete_book`, delete dialog | `delete_books` |
| Collection list/create/rename/reorder/delete/membership | all eight collection commands and sidebar controls | `manage_collections` |
| Normal/standalone readers and window focus/close/size | open reader utilities, window persistence, Reader controls | `get_reader_context`, `control_reader` |
| Active chapter/page/progress/visible text/selection/panel | Reader and foliate/text-reader callbacks | `get_reader_context` |
| Previous/next and chapter/page/CFI/bookmark/highlight/note/vocabulary/source/citation navigation | reader navigation, TOC, citation navigation | `control_reader`, `inspect_book_content` |
| Reader theme/brightness/font/layout/columns/margins/zoom/progress display/page bindings/panel width | Reader settings, per-book sync, panel resize | `control_reader`, `get_settings`, `update_settings` |
| App-wide zoom | app zoom hook/window service | `control_app`, `update_settings` |
| Prepared content, TOC, sections, ranges, locations | text document and reader structures | `inspect_book_content` |
| Lexical content search and source locations | existing MCP content search | `search_book_content` |
| Bookmark create/list/delete and labels | bookmark commands and panel | `query_annotations`, `manage_annotations` |
| Highlight create/list/range replacement/color/note/delete | highlight commands and toolbar | `query_annotations`, `manage_annotations` |
| First-class note create/edit/list/search/filter/context/delete | note commands, Notes view, learning cards | `query_annotations`, `manage_annotations` |
| Notes CSV export and source navigation | Notes view export/locate controls | `query_annotations` with CSV output, `control_reader` |
| Vocabulary CRUD/existence/all-book filters/detail | vocabulary commands and Dictionary view | `query_vocabulary`, `manage_vocabulary` |
| Mastery bulk/single, FSRS due/review/statistics | mastery/review/due/stats commands | `query_vocabulary`, `manage_vocabulary` |
| Vocabulary JSON/CSV export, preview, import/conflicts | backup commands and UI | `transfer_vocabulary` |
| Lookup save/cache/list/delete/clear/prune/retention | seven history commands and General settings | `query_lookup_history`, `manage_lookup_history`, `update_settings` |
| Word-form list/get/save/generation/deletion | word-form commands and manager | `manage_word_forms` |
| Whole-book rules, enablement, exceptions, occurrences, clear | 14 word-mark commands and reader controls | `manage_word_marks` |
| Chat list/search/filter/sort/get/create/rename/delete | nine chat commands and saved chat views | `query_chats`, `manage_chats` |
| Chat send/scopes/quotes/source passages/grounding/retry | `ai_chat`, chat hook, messages/citations | `chat_with_book`, `query_chats` |
| Message persistence/replacement | `save_chat_message`, `replace_chat_message` | Internal implementation of `chat_with_book` |
| Lookup/local dictionary/explain/translate/learning card/custom action | AI/dictionary/translation commands and reader popovers | `run_reading_action` |
| Vocabulary gloss/prompt optimization/chat title | generation commands and settings/editor flows | `generate_ai_material` |
| Cancel and inspect AI work | `ai_cancel`, streaming UI state | `manage_ai_tasks` |
| Book AI preparation/index state/details/update/rebuild | book AI/index commands and manager | `manage_book_intelligence` |
| Overview/section summary read/edit/regeneration | overview/section/regenerate commands | `manage_book_intelligence` |
| AI profiles active/list/create/duplicate/edit/enable/reorder/delete | AI settings commands/UI | `get_ai_services`, `manage_ai_services` |
| Models, reasoning options, health, cooldown, tests | model/effort/test commands and router health | `get_ai_services`, `manage_ai_services`, `test_ai_service` |
| Credential metadata/add/replace/enable/reorder/delete/test and legacy key | credential/key commands and cards | `manage_ai_credentials`, `test_ai_service` |
| OAuth login/status/logout | three OAuth commands | `manage_openai_oauth` |
| Vector retrieval status/enable/probe | embedding/vector commands | `manage_embeddings` |
| OCR runtime status/download/cancel/uninstall | package commands and settings | `manage_ocr_runtime` |
| OCR job start/cancel/retry/status/progress | manager commands and reader HUD | `manage_book_ocr` |
| OCR asset overview/local/all-device removal | asset commands and settings | `manage_book_ocr` |
| Dictionary/Edge/custom audio and system-voice playback | speech commands, speech hook/player | `get_speech_state`, `control_speech` |
| Speech models/voices/source/accent/rate/key/learned options | speech commands/settings | `get_speech_state`, `configure_speech` |
| Playback start/pause/resume/stop and highlighting | playback store/bar and reader | `get_speech_state`, `control_speech` |
| Speech cache stats/clear | cache commands | `get_speech_state`, `configure_speech` |
| Global/per-book ordinary settings | settings commands and all settings panels | `get_settings`, `update_settings` |
| Language/name/theme/reader defaults/learning tools/actions/bindings/markers/history/spoiler settings | General/Appearance/Reading/Tools panels | `get_settings`, `update_settings` |
| Custom font list/import/delete | font commands and Reading settings | `manage_custom_fonts` |
| Book-source list/add/edit/enable/reorder/delete/default restore | Book Sources structured setting | `manage_book_sources` |
| CEFR estimate/manual level/history/combined evidence/delete and language behavior | assessment commands and General settings | `manage_language_profile` |
| Sync status/folder/enable/disable/progress/now/cancel/compact | eight sync commands and Sync settings | `get_sync_status`, `manage_sync` |
| Sync peer list/removal | sync status/remove command | `get_sync_status`, `manage_sync` |
| Build/version/repository and bounded diagnostics/logs | app commands, About, reader diagnostics | `get_app_info` |
| Library/settings/saved-material/reader navigation and app zoom | app open commands, routes, zoom service | `control_app` |
| MCP client registration/config snippet/write access | four MCP commands and settings | `manage_mcp_integration` |
| App readiness and frontend warning ingestion | `app_ready`, `log_webview_warning` | Internal app plumbing, not an independent user action |

## Registered-command coverage audit

All 183 Tauri commands registered on the audit baseline are accounted for below. This is a completeness check, not a proposed public API.

| Command group | Count | Proposed path |
| --- | ---: | --- |
| `app::*` | 4 | `get_app_info`, `control_app`; lifecycle/log ingestion remain internal. |
| `books::*` | 17 | Library, file-lifecycle, and content tools. |
| `ocr::package::*` | 4 | `manage_ocr_runtime`. |
| `ocr::manager::*` | 6 | `manage_book_ocr`. |
| `ai::*` | 19 | Chat/reading actions, generated material, AI tasks, and book intelligence. |
| `settings::*` | 33 | Structured settings, AI services/credentials/embeddings, speech, and app control. |
| `fonts::*` | 3 | `manage_custom_fonts`. |
| `dictionary::*` | 1 | `run_reading_action` with local dictionary action. |
| `speech::*` | 10 | Three speech tools. |
| `language_assessments::*` | 5 | `manage_language_profile`. |
| `bookmarks::*` | 9 | Two annotation tools. |
| `notes::*` | 4 | Two annotation tools; CSV output is frontend-derived. |
| `word_marks::*` | 14 | Word-form and word-mark tools. |
| `collections::*` | 8 | `manage_collections`. |
| `oauth::*` | 3 | `manage_openai_oauth`. |
| `vocab::*` | 14 | Vocabulary query/manage/transfer. |
| `lookup_history::*` | 7 | Lookup query/manage and reading-action persistence. |
| `chats::*` | 9 | Chat query/manage plus persistence behind `chat_with_book`. |
| `translation::*` | 1 | `run_reading_action` with translation action. |
| `mcp::*` | 4 | `manage_mcp_integration`. |
| `sync::*` | 8 | Sync status/manage. |
| **Total** | **183** | **No registered command group is omitted.** |

## Confirmation policy

Confirmation is based on the concrete effect after Lantern resolves routing, scope, and platform capability. It is not based on the tool name alone.

Confirmation is required only when:

1. The operation may send a billable request to a paid or unknown-cost API.
2. The operation will perform a dangerous irreversible change, such as permanently deleting primary user data, destructively overwriting it, or changing sync state in a way that may make unique files unavailable.

All such capabilities remain callable. Confirmation blocks only the exact pending action and binds to its complete arguments. One approval may cover a clearly bounded batch, service/model, and maximum request count. Work outside that scope requires another approval.

No confirmation is required for reads, searches, navigation, ordinary edits/settings, local indexing/conversion/OCR, reproducible cache clearing, cancellation, or retry work that cannot incur additional charges.

Paid confirmation states action, service, model, bounded request count/scope, and an estimate/upper bound when calculable; otherwise it states factually that the provider may charge. Irreversible confirmation states exact object type, IDs/count, scope, preservation policy, and consequence. Neither tells the user whether to proceed.

## Capabilities that are not shipped

These are not current parity gaps and do not appear in the 48-tool catalog until the corresponding Lantern capability ships.

| Capability | Evidence/status |
| --- | --- |
| In-app update check/download/apply | `PlatformCapabilities.hasUpdater` says there is no consumer and Lantern ships no updater; translation strings are dormant and there is no updater command/UI. |
| Collection folders | Feature document exists, but no shipped model or UI. |
| Full library backup/restore/reset | Feature document exists, but no shipped app workflow or registered commands. |
| Reading statistics | No shipped statistics surface; vocabulary review statistics are shipped and included. |
| Persisted explanation records | Explanations are transient unless represented in chat/history/note data. |
| AI-assisted note threads | First-class notes ship; note threads do not. |
| Generic cloud-data deletion | Only concrete sync-peer and all-device OCR-asset behaviors exist. |

Mobile/desktop differences are runtime capability results, not separate catalogs. MCP integration itself currently ships on desktop only.

## Implementation constraints

- `tools/list` returns the complete catalog; grouping may improve presentation but cannot hide tools by default.
- Tagged action schemas use discriminated unions so unrelated fields are not valid together.
- Single/batch operations share one bounded item-array schema.
- High-risk gates inspect the resolved action and exact arguments inside a tool; combining lifecycle actions never broadens confirmation to ordinary operations.
- Tools use stable product IDs and return per-item results for partial batch failures.
- Long-running operations return task identity and expose pending/completed/cancelled/failed state through relevant state/query actions.
- Credential responses return metadata/configured status, never plaintext stored secrets.
- Live reader, playback, OAuth, picker, navigation, and app-state actions use an authenticated local app bridge because the stdio process does not own Tauri runtime state.
- The bridge is internal and is not a generic model-facing tool.
- Unsupported-platform results are factual and structured; tools remain discoverable.
- Every action declares factual read/write, local/network, paid-potential, destructive-potential, and idempotency metadata.

## Acceptance criteria

- `tools/list` contains exactly the 48 names in this document for this implementation scope.
- A catalog test fails on missing/unexpected/duplicated/deprecated aliases and single/batch or field-level duplicates.
- Schema tests prove every allowed tagged action and reject unrelated-field combinations.
- Every shipped-inventory row has an integration or contract test proving its MCP path.
- All 183 registered command groups remain accounted for, including commands deliberately kept internal.
- Live tools are tested with no app, one reader, and multiple reader windows.
- Paid routing tests prove no billable request is sent before exact approval and local/free routes execute directly.
- Irreversible tests prove exact action/argument binding, rejection, one-time consumption, and replay prevention.
- Ordinary reads/writes execute without per-action confirmation once MCP write access is enabled.
- Descriptions state effects and boundaries without prescribing a workflow.
- Current, pending, completed, cancelled, failed, unavailable, and partially completed states are observable where Lantern exposes them.

## Resolved product choices and remaining questions

- All 48 tools are discoverable by default.
- The focused reader is the default live target; explicit `window_id` resolves multi-window targeting.
- Query/export actions return content and may write to an explicit destination path.
- Local/reproducible cache and OCR-asset removal is not dangerous primary-data deletion.
- Deleting books, personal reading data, assessments, chats, credentials, profiles, or destructive import content requires confirmation.
- Tool grouping is presentation only and never reduces capability availability.
- Dormant updater strings do not constitute a shipped updater.

**No unresolved product-design question currently blocks implementation.** Remaining unknowns are implementation details: bridge transport, platform adapter mechanics, and exact test fixtures.
