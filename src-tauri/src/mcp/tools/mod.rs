//! MCP tool registry. Each submodule adds one or more
//! `#[tool_router]`-decorated `impl LanternMcpHandler` blocks; the macro
//! generates per-file `<name>_router()` associated functions that
//! `LanternMcpHandler::tool_router()` (in `mcp/server.rs`) merges into a
//! single `ToolRouter`.
//!
//! MCP is Lantern's complete external control surface. Product capabilities
//! are not withheld merely because they are sensitive. Operations that may
//! spend money or irreversibly destroy data must use the approval flow before
//! execution. Stored plaintext credentials remain subject to the same
//! non-export boundary as the app UI.
//!
//! Every new tool MUST be added to `LanternMcpHandler::tool_router()`'s
//! merge list, the registry tests, and this audit. Current routers are
//! `library_router`, `library_write_router`, `library_batch_router`,
//! `content_router`, `learning_router`, `highlights_router`,
//! `bookmarks_router`, `vocab_router`, `chats_router`,
//! `collections_write_router`, `annotations_write_router`,
//! `vocab_write_router`, `chats_write_router`, and
//! `assessments_write_router`, `configuration_router`, `app_info_router`,
//! and `integration_router`.

pub mod annotations_write;
pub mod app_info;
pub mod assessments_write;
pub mod bookmarks;
pub mod chats;
pub mod chats_write;
pub mod collections;
pub mod configuration;
pub mod content;
pub mod highlights;
pub mod integration;
pub mod learning;
pub mod library;
pub mod library_batch;
pub mod local_catalog;
pub mod vocab;
pub mod vocab_write;
