//! Local, rebuildable grounding data for book chat.

pub mod aliases;
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

/// How a long grounding pass reports how far it has got: `(done, total)`,
/// counted in whatever unit that pass works in, called once per unit of
/// progress.
///
/// A callback rather than an `AppHandle` — even though several files here
/// already take one — because the alternative is worse in a specific way.
/// The channel these numbers end up on and the payload they arrive in belong
/// to `commands::ai::book_index`, which owns the four-phase run they are one
/// phase of; handing the pass an `AppHandle` would mean either importing that
/// command module's payload type down here, or inventing a second progress
/// event with its own shape for the same run. Neither is worth it for a
/// two-integer report. It also keeps these passes callable from a test with
/// no mock app.
///
/// `Sync`, not `Send`: the callback is borrowed across an `await` inside an
/// async fn whose future has to be `Send`, and `&T` is `Send` exactly when
/// `T` is `Sync`.
pub type ProgressFn<'a> = &'a (dyn Fn(usize, usize) + Sync);

pub use extract::{BlockText, SectionText};
pub use index::IndexStatus;
pub use retrieve::{retrieve, CitedSource, RetrievedChunk};
