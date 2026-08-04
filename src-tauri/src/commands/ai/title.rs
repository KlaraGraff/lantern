//! `ai_generate_title` — the short chat-thread title generated from the first
//! exchange.

use tauri::{AppHandle, State};

use super::prompt::truncate_utf8;
use super::stream::{ensure_stream_credentials_ready, spawn_routed_stream};
use super::ChatMessage;
use crate::db::Db;
use crate::error::AppResult;
use crate::secrets::Secrets;

#[tauri::command]
pub async fn ai_generate_title(
    user_message: String,
    assistant_message: String,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    let language = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        get("language").unwrap_or_else(|| "en".to_string())
    };

    let user_snippet = truncate_utf8(&user_message, 200);
    let ai_snippet = truncate_utf8(&assistant_message, 200);

    let title_lang_hint = if language == "zh" {
        " Generate the title in Chinese."
    } else {
        ""
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: format!("Generate a very short title (3-6 words) for the following chat exchange.{} Respond with ONLY the title, no quotes, no punctuation at the end.", title_lang_hint),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("User: {}\nAssistant: {}", user_snippet, ai_snippet),
        },
    ];

    let event_name = format!("ai-title-chunk-{}", request_id);
    ensure_stream_credentials_ready(&db, &secrets)?;
    spawn_routed_stream(
        app,
        db.inner().clone(),
        secrets.inner().clone(),
        messages,
        event_name,
        Some(32),
        crate::ai::router::AiRequestPurpose::Utility,
        crate::ai::router::AiRetryMode::Automatic,
        request_id,
    );

    Ok(())
}
