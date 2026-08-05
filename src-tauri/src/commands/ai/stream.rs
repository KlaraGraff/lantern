//! Streaming plumbing: the chunk envelope the frontend listens for, the
//! failure code it is allowed to see, and the spawn/cancel pair every
//! streaming command goes through.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::ChatMessage;
use crate::ai::grounding::CitedSource;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiStreamChunk {
    pub delta: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_delta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<CitedSource>>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn public_stream_error_code(error: &AppError) -> &'static str {
    const CONFIGURATION_ERRORS: [&str; 5] = [
        "AI_NOT_CONFIGURED",
        "AI_KEYS_DISABLED",
        "AI_ALL_KEYS_INVALID",
        "AI_KEYS_COOLING_DOWN",
        "AI_NO_USABLE_KEYS",
    ];
    let message = error.to_string();
    CONFIGURATION_ERRORS
        .into_iter()
        .find(|code| message.contains(code))
        .unwrap_or("AI_STREAM_FAILED")
}

pub(crate) fn emit_stream_failure(app: &AppHandle, event_name: &str, error: &AppError) {
    if error.to_string().contains("AI_REQUEST_CANCELLED") {
        return;
    }
    log::error!("AI stream failed on {event_name}: {error}");
    let _ = app.emit(
        event_name,
        AiStreamChunk {
            delta: String::new(),
            reasoning_delta: None,
            sources: None,
            done: true,
            error: Some(public_stream_error_code(error).to_string()),
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_routed_stream(
    app: AppHandle,
    db: Db,
    secrets: Secrets,
    messages: Vec<ChatMessage>,
    event_name: String,
    max_tokens: Option<u32>,
    purpose: crate::ai::router::AiRequestPurpose,
    retry: crate::ai::router::AiRetryMode,
    request_id: String,
    origin: &'static str,
    feature: &'static str,
) {
    // Register before spawning so an immediate Stop click can never race the
    // task's first poll of the cancellation registry.
    crate::ai::router::register_request(&request_id);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::ai::router::stream_with_failover(
            &app,
            &db,
            &secrets,
            &messages,
            &event_name,
            max_tokens,
            purpose,
            retry,
            Some(&request_id),
            origin,
            feature,
        )
        .await
        {
            emit_stream_failure(&app, &event_name, &error);
        }
    });
}

pub(super) fn ensure_stream_credentials_ready(db: &Db, secrets: &Secrets) -> AppResult<()> {
    crate::ai::router::ensure_stream_credentials_accessible(db, secrets)
}

#[tauri::command]
pub fn ai_cancel(request_id: String) -> bool {
    crate::ai::router::cancel_request(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_failures_preserve_public_key_pool_states() {
        for code in [
            "AI_NOT_CONFIGURED",
            "AI_KEYS_DISABLED",
            "AI_ALL_KEYS_INVALID",
            "AI_KEYS_COOLING_DOWN",
            "AI_NO_USABLE_KEYS",
        ] {
            assert_eq!(
                public_stream_error_code(&AppError::Other(code.to_string())),
                code
            );
        }
        assert_eq!(
            public_stream_error_code(&AppError::Ai("provider request failed".to_string())),
            "AI_STREAM_FAILED"
        );
    }
}
