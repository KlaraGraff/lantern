use futures::StreamExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

fn request_body(model: &str, messages: &[ChatMessage], effort: Option<&str>) -> serde_json::Value {
    let instructions: String = messages
        .iter()
        .filter(|message| matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| message.content.as_str())
        .collect();
    let input: Vec<serde_json::Value> = messages
        .iter()
        .filter(|message| !matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": model,
        "instructions": instructions,
        "input": input,
        "stream": true,
        "store": false,
    });
    // The Responses API nests the level under `reasoning`, unlike the
    // chat-completions shape's top-level `reasoning_effort`.
    if let Some(effort) = effort {
        body["reasoning"] = serde_json::json!({ "effort": effort });
    }
    body
}

/// Stream chat using OpenAI's Responses API (`/responses`).
/// When using OAuth tokens, requests go to `chatgpt.com/backend-api/codex`
/// with the `chatgpt-account-id` header (same as Codex CLI).
///
/// Request format matches `ResponsesApiRequest` from the Codex CLI source:
///   model, instructions, input, tools, tool_choice, parallel_tool_calls,
///   store, stream — no temperature, no max_output_tokens.
#[allow(clippy::too_many_arguments)]
pub async fn stream_chat<R: Runtime>(
    app: &AppHandle<R>,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    account_id: Option<&str>,
    event_name: &str,
    effort: Option<&str>,
    emitted: Arc<AtomicBool>,
    usage: Arc<Mutex<Option<serde_json::Value>>>,
) -> AppResult<()> {
    let client = crate::ai::http_client();
    let url = format!("{}/responses", base_url.trim_end_matches('/'));

    // Responses API uses top-level "instructions" for system messages,
    // and "input" for user/assistant messages only.
    let body = request_body(model, messages, effort);

    let mut request = client.post(&url).bearer_auth(api_key).json(&body);
    if let Some(acct) = account_id {
        request = request.header("chatgpt-account-id", acct);
    }

    let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.send())
        .await
        .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
        .map_err(|e| AppError::Ai(e.to_string()))?;

    if !response.status().is_success() {
        return Err(crate::ai::http_status_error("OpenAI", response).await);
    }

    let mut stream = response.bytes_stream();
    let mut decoder = crate::ai::sse::SseDecoder::new();

    while let Some(chunk) = tokio::time::timeout(crate::ai::STREAM_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| AppError::Ai("AI_STREAM_IDLE_TIMEOUT".to_string()))?
    {
        let chunk = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        for data in decoder.push(&chunk)? {
            if process_data(app, event_name, &data, &emitted, &usage)? {
                return Ok(());
            }
        }
    }

    for data in decoder.finish()? {
        if process_data(app, event_name, &data, &emitted, &usage)? {
            return Ok(());
        }
    }

    Err(AppError::Ai("AI_STREAM_INCOMPLETE".to_string()))
}

fn process_data<R: Runtime>(
    app: &AppHandle<R>,
    event_name: &str,
    data: &str,
    emitted: &AtomicBool,
    usage: &Mutex<Option<serde_json::Value>>,
) -> AppResult<bool> {
    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|_| AppError::Ai("AI_STREAM_PROTOCOL_ERROR: invalid JSON event".to_string()))?;
    match parsed["type"].as_str().unwrap_or("") {
        "response.output_text.delta" => {
            // Skip empty deltas so a leading blank chunk doesn't block failover
            // to another credential (see the `emitted` gate in the router).
            if let Some(delta) = parsed["delta"].as_str().filter(|value| !value.is_empty()) {
                emitted.store(true, Ordering::Relaxed);
                let _ = app.emit(
                    event_name,
                    AiStreamChunk {
                        delta: delta.to_string(),
                        reasoning_delta: None,
                        sources: None,
                        done: false,
                        error: None,
                    },
                );
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let Some(delta) = parsed["delta"].as_str().filter(|value| !value.is_empty()) {
                emitted.store(true, Ordering::Relaxed);
                let _ = app.emit(
                    event_name,
                    AiStreamChunk {
                        delta: String::new(),
                        reasoning_delta: Some(delta.to_string()),
                        sources: None,
                        done: false,
                        error: None,
                    },
                );
            }
        }
        // The Responses API reports mid-stream failures as a top-level `error`
        // event or a `response.failed` event carrying `response.error`. Surface
        // the real code instead of ending as a generic AI_STREAM_INCOMPLETE.
        "error" => {
            return Err(crate::ai::stream_event_error("OpenAI", &parsed));
        }
        "response.failed" => {
            return Err(crate::ai::stream_event_error(
                "OpenAI",
                &parsed["response"]["error"],
            ));
        }
        "response.completed" => {
            // Unlike chat/completions, the Responses API includes usage on
            // the completion event automatically — no `stream_options` opt-in
            // needed.
            if let Some(value) = parsed["response"].get("usage") {
                crate::ai::usage::merge_into(usage, value.clone());
            }
            let _ = app.emit(
                event_name,
                AiStreamChunk {
                    delta: String::new(),
                    reasoning_delta: None,
                    sources: None,
                    done: true,
                    error: None,
                },
            );
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separated_system_content_is_concatenated_into_instructions() {
        let body = request_body(
            "model",
            &[
                ChatMessage {
                    role: "system".into(),
                    content: "stable".into(),
                },
                ChatMessage {
                    role: "system_cache_variable".into(),
                    content: " variable".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "Question".into(),
                },
            ],
            None,
        );
        assert_eq!(body["instructions"], "stable variable");
        assert_eq!(
            body["input"][0],
            serde_json::json!({ "role": "user", "content": "Question" })
        );
    }

    #[test]
    fn failed_response_event_surfaces_provider_code() {
        let error = crate::ai::stream_event_error(
            "OpenAI",
            &serde_json::json!({ "type": "rate_limit_exceeded", "code": "rate_limit_exceeded" }),
        );
        assert!(error.to_string().contains("code=rate_limit_exceeded"));
    }
}
