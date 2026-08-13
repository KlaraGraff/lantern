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

/// Shared by the live runs in `context.rs` and `aliases.rs`: both need the
/// reader's own database, and neither may open it.
#[cfg(test)]
pub mod live_data {
    /// The reader's app data, copied — never opened. `-wal` and `-shm` come
    /// along because the running app checkpoints lazily, and a copy of the main
    /// file alone would silently miss its most recent writes.
    ///
    /// `None` means there is no Lantern installation here to copy, which is the
    /// normal state on CI and the reason every caller is `#[ignore]`d.
    pub fn copy_app_data(destination: &std::path::Path) -> Option<()> {
        let source = home()?.join("Library/Application Support/com.klaragraff.lantern");
        if !source.join("secrets.db").exists() {
            return None;
        }
        for name in [
            "lantern.db",
            "lantern.db-wal",
            "lantern.db-shm",
            "secrets.db",
        ] {
            let from = source.join(name);
            if from.exists() {
                std::fs::copy(&from, destination.join(name)).ok()?;
            }
        }
        Some(())
    }

    fn home() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
}
