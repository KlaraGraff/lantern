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

/// Defensive ceiling per `user_image` data URI. The quiz frontend compresses
/// screenshots to ~1600px JPEG before sending (typically well under 1MB of
/// base64); anything near this limit is a caller bug, not a big screenshot.
const MAX_IMAGE_DATA_URI_BYTES: usize = 10 * 1024 * 1024;

/// The message-shape half of the command's input validation, split out as a
/// pure function so tests can exercise it without a Tauri `State`.
///
/// `user_image` is an in-band role (the `system_cache_variable` precedent):
/// its content must be a `data:image/...;base64,` URI of an allow-listed
/// image type, which each provider channel folds into the next user turn as
/// its own multimodal content shape (`crate::ai::merge_image_messages`).
fn validate_messages(messages: &[ChatMessage]) -> AppResult<()> {
    if messages.is_empty() {
        return Err(AppError::Other(
            "AI_COMPLETE_TEXT_MESSAGES_EMPTY".to_string(),
        ));
    }
    for message in messages {
        match message.role.as_str() {
            "user" | "assistant" => {}
            "user_image" => {
                if crate::ai::parse_image_data_uri(&message.content).is_none() {
                    return Err(AppError::Other(
                        "AI_COMPLETE_TEXT_IMAGE_INVALID".to_string(),
                    ));
                }
                if message.content.len() > MAX_IMAGE_DATA_URI_BYTES {
                    return Err(AppError::Other(
                        "AI_COMPLETE_TEXT_IMAGE_TOO_LARGE".to_string(),
                    ));
                }
            }
            _ => {
                return Err(AppError::Other("AI_COMPLETE_TEXT_ROLE_INVALID".to_string()));
            }
        }
    }
    Ok(())
}

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
    // Forces this one call onto a single `ai_profiles` row instead of the
    // usual priority+failover route — quiz generation pins the profile the
    // reader picked for grading rather than letting the router wander onto
    // whatever answers first. `None` is every other caller: unchanged
    // priority/cooldown routing. See `router::pin_profile`.
    profile_id: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<AiCompleteTextResponse> {
    if request_id.len() > 128 || request_id.trim().is_empty() {
        return Err(AppError::Other("AI_REQUEST_ID_INVALID".to_string()));
    }
    validate_messages(&messages)?;
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
        profile_id.as_deref(),
    )
    .await?;
    Ok(AiCompleteTextResponse {
        text: completion.text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn error_code(result: AppResult<()>) -> String {
        result.expect_err("expected validation failure").to_string()
    }

    #[test]
    fn user_and_assistant_turns_pass() {
        assert!(validate_messages(&[message("user", "q"), message("assistant", "a")]).is_ok());
    }

    #[test]
    fn empty_messages_are_rejected() {
        assert!(error_code(validate_messages(&[])).contains("AI_COMPLETE_TEXT_MESSAGES_EMPTY"));
    }

    #[test]
    fn unknown_roles_are_rejected() {
        let result = validate_messages(&[message("system", "sneaky")]);
        assert!(error_code(result).contains("AI_COMPLETE_TEXT_ROLE_INVALID"));
    }

    #[test]
    fn a_well_formed_image_message_passes() {
        assert!(validate_messages(&[
            message("user_image", "data:image/jpeg;base64,AAA"),
            message("user", "extract the words"),
        ])
        .is_ok());
    }

    #[test]
    fn a_non_data_uri_image_message_is_rejected() {
        let result = validate_messages(&[message("user_image", "not an image")]);
        assert!(error_code(result).contains("AI_COMPLETE_TEXT_IMAGE_INVALID"));
    }

    #[test]
    fn a_disallowed_media_type_is_rejected() {
        let result = validate_messages(&[message("user_image", "data:application/pdf;base64,AA")]);
        assert!(error_code(result).contains("AI_COMPLETE_TEXT_IMAGE_INVALID"));
    }

    #[test]
    fn an_oversized_image_is_rejected() {
        let huge = format!(
            "data:image/jpeg;base64,{}",
            "A".repeat(10 * 1024 * 1024 + 1)
        );
        let result = validate_messages(&[message("user_image", &huge)]);
        assert!(error_code(result).contains("AI_COMPLETE_TEXT_IMAGE_TOO_LARGE"));
    }
}
