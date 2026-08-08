//! Local, rebuildable grounding data for book chat.

pub mod chunk;
pub mod context;
pub mod extract;
pub mod index;
pub mod language;
pub mod quotes;
pub mod retrieve;
pub mod segment;
pub mod source;
pub mod spoiler;
pub mod summarize;
pub mod vector;
pub mod vocabulary;

pub const INDEX_VERSION: i64 = 1;
pub const RETRIEVAL_TOP_K: usize = 12;
/// Chat re-retrieves on every message and shares the provider's context
/// window with growing conversation history, so it stays well below
/// ai_xray's retrieval budget (`XRAY_RETRIEVAL_BUDGET_TOKENS` in
/// `commands/ai/xray.rs`), which spends a whole request on one entity.
pub const RETRIEVAL_BUDGET_TOKENS: usize = 24_000;
pub const OVERVIEW_BUDGET_TOKENS: usize = 1_500;
pub const CHUNK_TARGET_TOKENS: usize = 350;
pub const CHUNK_MAX_TOKENS: usize = 500;
pub const SNIPPET_MAX_CHARS: usize = 120;

pub use extract::{BlockText, SectionText};
pub use index::IndexStatus;
pub use retrieve::{retrieve, CitedSource, RetrievedChunk};
