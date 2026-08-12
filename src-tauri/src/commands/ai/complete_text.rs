//! `ai_complete_text`: a generic multi-turn completion command for features
//! that orchestrate their own prompts on the frontend (currently quiz
//! generation's two-phase pipeline — see docs/impls/cijuan-merge.md §二.6)
//! rather than going through one of Lantern's purpose-built AI commands.
//!
//! Frontend/backend contract (both sides developed in parallel; this must
//! match exactly): `messages` carries only `"user"`/`"assistant"` turns —
//! anything else is rejected rather than silently reinterpreted. `system` is
//! a separate, optional field, not a message with `role: "system"`. Tauri 2
//! maps the frontend's camelCase `maxTokens` to `max_tokens` automatically.
//! `cache: true` asks the Anthropic channel to mark the last message (and the
//! system prompt, if present) with `cache_control: ephemeral`; every other
//! channel ignores the flag by construction, since it is never threaded into
//! their request builders (see `crate::ai::anthropic::request_body`).

use tauri::{AppHandle, State};

use super::stream::ensure_stream_credentials_ready;
use super::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

/// Generous enough for quiz generation's whole-article-plus-questions output,
/// small enough that a caller cannot use this general-purpose command to force
/// an unbounded bill onto whichever AI profile is configured.
const MAX_TOKENS_CEILING: u32 = 16_000;

#[derive(Debug, serde::Serialize)]
pub struct AiCompleteTextResponse {
    pub text: String,
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_complete_text(
    messages: Vec<ChatMessage>,
    system: Option<String>,
    max_tokens: u32,
    cache: Option<bool>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<AiCompleteTextResponse> {
    if request_id.len() > 128 || request_id.trim().is_empty() {
        return Err(AppError::Other("AI_REQUEST_ID_INVALID".to_string()));
    }
    if messages.is_empty() {
        return Err(AppError::Other(
            "AI_COMPLETE_TEXT_MESSAGES_EMPTY".to_string(),
        ));
    }
    if messages
        .iter()
        .any(|message| message.role != "user" && message.role != "assistant")
    {
        return Err(AppError::Other("AI_COMPLETE_TEXT_ROLE_INVALID".to_string()));
    }
    if max_tokens == 0 || max_tokens > MAX_TOKENS_CEILING {
        return Err(AppError::Other(
            "AI_COMPLETE_TEXT_MAX_TOKENS_INVALID".to_string(),
        ));
    }

    let mut full_messages = Vec::with_capacity(messages.len() + 1);
    if let Some(system) = system.filter(|value| !value.is_empty()) {
        full_messages.push(ChatMessage {
            role: "system".to_string(),
            content: system,
        });
    }
    full_messages.extend(messages);

    ensure_stream_credentials_ready(&db, &secrets)?;
    let completion = crate::ai::router::complete_with_failover_cached(
        &app,
        &db,
        &secrets,
        &full_messages,
        Some(max_tokens),
        crate::ai::router::AiRequestPurpose::Analysis,
        crate::ai::router::AiRetryMode::Automatic,
        Some(&request_id),
        None,
        "user",
        "quiz",
        cache.unwrap_or(false),
    )
    .await?;
    Ok(AiCompleteTextResponse {
        text: completion.text,
    })
}
