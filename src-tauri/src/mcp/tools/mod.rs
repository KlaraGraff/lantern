//! MCP tool registry. Each submodule adds one or more
//! `#[tool_router]`-decorated `impl LanternMcpHandler` blocks; the macro
//! generates per-file `<name>_router()` associated functions that
//! `LanternMcpHandler::tool_router()` (in `mcp/server.rs`) merges into a
//! single `ToolRouter`.
//!
//! MCP exposes reader context and a small, write-gated library surface. It
//! never invokes AI providers or exposes device/service configuration.
//! Permanent deletion and destructive overwrite use the approval flow.
//!
//! Every new tool MUST be added to `LanternMcpHandler::tool_router()`'s
//! merge list, the registry tests, and this audit. Current routers are
//! `library_router`, `library_write_router`, `library_batch_router`,
//! `content_router`, `learning_router`, `highlights_router`,
//! `bookmarks_router`, `vocab_router`, `chats_router`,
//! `collections_write_router`, `annotations_write_router`,
//! `vocab_write_router`, `chats_write_router`, and
//! `open_reader_router`.

pub mod annotations_write;
pub mod bookmarks;
pub mod chats;
pub mod chats_write;
pub mod collections;
pub mod content;
pub mod highlights;
pub mod learning;
pub mod library;
pub mod library_batch;
pub mod local_catalog;
pub mod open_reader;
pub mod vocab;
pub mod vocab_write;
