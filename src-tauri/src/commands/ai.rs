use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

mod book_index;
mod chat;
mod complete_text;
mod custom_action;
mod explain;
mod intent;
mod learning_card;
mod lookup;
mod person_aliases;
mod prompt;
mod request_counts;
mod routing;
mod stream;
mod title;
mod usage;
pub(crate) mod vocabulary;
mod word_forms;
mod xray;

// Command modules are re-exported whole: `#[tauri::command]` generates companion
// items next to each function, and `tauri::generate_handler!` in lib.rs resolves
// all of them through `commands::ai::<name>`.
pub use book_index::*;
pub use chat::*;
pub use complete_text::*;
pub use custom_action::*;
pub use explain::*;
pub use learning_card::*;
pub use lookup::*;
pub use person_aliases::*;
pub use request_counts::*;
pub use stream::*;
pub use title::*;
pub use usage::*;
pub use vocabulary::*;
pub use word_forms::*;
pub use xray::*;

pub(crate) use prompt::book_reference_block;
