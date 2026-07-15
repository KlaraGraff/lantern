//! MCP tool registry. Each submodule adds one or more
//! `#[tool_router]`-decorated `impl QuillMcpHandler` blocks; the macro
//! generates per-file `<name>_router()` associated functions that
//! `QuillMcpHandler::tool_router()` (in `mcp/server.rs`) merges into a
//! single `ToolRouter`.
//!
//! ## Forbidden surfaces — DO NOT ADD TOOLS THAT TOUCH:
//!
//! - `settings` table — settings can contain sensitive legacy values. Tool
//!   implementations may internally read only `mcp_write_enabled`,
//!   `ai_spoiler_guard`, and `book_spoiler_guard_{book_id}`. Do not expose a
//!   settings tool or read any other key from MCP code.
//! - `oauth` / OAuth tokens — `commands::oauth::*`.
//! - Secrets store — separate `Mutex<Connection>`; never add a
//!   `Secrets` clone to `McpState`.
//! - `ai_profiles` health/infrastructure fields (`state`, `cooldown_until`,
//!   `last_error_kind`, `last_used_at`, `last_latency_ms`).
//! - Embedding tables and every entry point in `grounding/vector.rs`; MCP
//!   tools must never cause billable model calls.
//! - Language-assessment writes and estimation. Only the read projection in
//!   `get_language_profile` is allowed.
//! - `lookup_records.result_json` and `provider_profile_id`; MCP lookup DTOs
//!   must explicitly omit them.
//! - Every `updated_by_device` column; device identity never enters MCP DTOs.
//! - Sync infra tables — `_replay_state`, `_tombstones`,
//!   `_pending_publish` (migrations 010/011).
//! - Device identity, sync logs.
//!
//! Every new tool MUST be added to `QuillMcpHandler::tool_router()`'s
//! merge list, the registry tests, and this audit. Current routers are
//! `library_router`, `library_write_router`, `library_batch_router`,
//! `content_router`, `learning_router`, `highlights_router`,
//! `bookmarks_router`, `vocab_router`, `chats_router`, and
//! `collections_write_router`.

pub mod bookmarks;
pub mod chats;
pub mod collections;
pub mod content;
pub mod highlights;
pub mod learning;
pub mod library;
pub mod library_batch;
pub mod vocab;
