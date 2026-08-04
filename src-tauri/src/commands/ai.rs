use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::secrets::Secrets;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

mod book_index;
mod chat;
mod custom_action;
mod explain;
mod intent;
mod learning_card;
mod lookup;
mod prompt;
mod routing;
mod stream;
mod title;
mod vocabulary;
mod word_forms;
mod xray;

// Command modules are re-exported whole: `#[tauri::command]` generates companion
// items next to each function, and `tauri::generate_handler!` in lib.rs resolves
// all of them through `commands::ai::<name>`.
pub use book_index::*;
pub use chat::*;
pub use custom_action::*;
pub use explain::*;
pub use learning_card::*;
pub use lookup::*;
pub use stream::*;
pub use title::*;
pub use vocabulary::*;
pub use word_forms::*;

pub(crate) use prompt::book_reference_block;

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_xray(
    book_id: String,
    entity: String,
    visible_context: Option<String>,
    current_location: Option<String>,
    current_chapter: Option<String>,
    progress: i32,
    spoiler_override: bool,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<xray::XrayCardResponse> {
    xray::run_xray(
        book_id,
        entity,
        visible_context,
        current_location,
        current_chapter,
        progress,
        spoiler_override,
        request_id,
        app,
        db,
        secrets,
    )
    .await
}
