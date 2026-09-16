use futures::StreamExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

fn request_body(
    model: &str,
    messages: &[ChatMessage],
    effort: Option<&str>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> serde_json::Value {
    let instructions: String = messages
        .iter()
        .filter(|message| matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| message.content.as_str())
        .collect();
    let input: Vec<serde_json::Value> =
        crate::ai::merge_image_messages(messages.iter().filter(|message| {
            !matches!(message.role.as_str(), "system" | "system_cache_variable")
        }))
        .into_iter()
        .map(|message| {
            if message.images.is_empty() {
                // Image-free messages keep plain-string content, unchanged from
                // before images existed.
                return serde_json::json!({
                    "role": message.role,
                    "content": message.text,
                });
            }
            let mut parts: Vec<serde_json::Value> = message
                .images
                .iter()
                .map(|uri| serde_json::json!({ "type": "input_image", "image_url": uri }))
                .collect();
            if !message.text.is_empty() {
                parts.push(serde_json::json!({ "type": "input_text", "text": message.text }));
            }
            serde_json::json!({ "role": "user", "content": parts })
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
    if let Some(temperature) = temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(max_output_tokens) = max_output_tokens {
        body["max_output_tokens"] = serde_json::json!(max_output_tokens);
    }
    body
}

/// Stream chat using OpenAI's Responses API (`/responses`).
/// When using OAuth tokens, requests go to `chatgpt.com/backend-api/codex`
/// with the `chatgpt-account-id` header (same as Codex CLI).
///
/// OAuth requests keep the Codex-style shape without sampling or token-limit
/// fields. API-key profiles also carry Lantern's configured temperature and
/// any caller limit so choosing Responses does not silently discard them.
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
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
    emitted: Arc<AtomicBool>,
    usage: Arc<Mutex<Option<serde_json::Value>>>,
) -> AppResult<()> {
    let client = crate::ai::http_client();
    let url = crate::ai::compat_endpoint(base_url, "responses");

    // Responses API uses top-level "instructions" for system messages,
    // and "input" for user/assistant messages only.
    let body = request_body(model, messages, effort, temperature, max_output_tokens);

    let mut request = client.post(&url).json(&body);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    if let Some(acct) = account_id {
        request = request.header("chatgpt-account-id", acct);
    }

    let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.send())
        .await
        .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
        .map_err(|e| AppError::Ai(e.to_string()))?;

    if !response.status().is_success() {
        let (status, retry_after, error_body) = crate::ai::read_error_response(response).await;
        if crate::ai::protocol_incompatible(status, &error_body) {
            return Err(AppError::Ai(format!(
                "AI_PROTOCOL_INCOMPATIBLE provider=OpenAI-compatible status={}",
                status.as_u16()
            )));
        }
        return Err(crate::ai::http_status_error_from_body(
            "OpenAI-compatible",
            status,
            retry_after,
            &error_body,
        ));
    }

    let is_event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    if !is_event_stream {
        let bytes = tokio::time::timeout(crate::ai::STREAM_IDLE_TIMEOUT, response.bytes())
            .await
            .map_err(|_| AppError::Ai("AI_STREAM_IDLE_TIMEOUT".to_string()))?
            .map_err(|error| AppError::Ai(error.to_string()))?;
        let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
            AppError::Ai("AI_STREAM_PROTOCOL_ERROR: invalid JSON response".to_string())
        })?;
        return emit_completed_response(app, event_name, &payload, &emitted, &usage);
    }

    let mut stream = response.bytes_stream();
    let mut decoder = crate::ai::sse::SseDecoder::new();
    let mut state = ResponseStreamState::default();

    while let Some(chunk) = tokio::time::timeout(crate::ai::STREAM_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| AppError::Ai("AI_STREAM_IDLE_TIMEOUT".to_string()))?
    {
        let chunk = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        for data in decoder.push(&chunk)? {
            if process_data(app, event_name, &data, &emitted, &usage, &mut state)? {
                return Ok(());
            }
        }
    }

    for data in decoder.finish()? {
        if process_data(app, event_name, &data, &emitted, &usage, &mut state)? {
            return Ok(());
        }
    }

    Err(AppError::Ai("AI_STREAM_INCOMPLETE".to_string()))
}

#[derive(Default)]
struct ResponseStreamState {
    emitted_text: bool,
}

fn response_output(payload: &serde_json::Value) -> AppResult<(String, bool)> {
    if payload["status"].as_str() != Some("completed") {
        return Err(AppError::Ai("AI_RESPONSE_INCOMPLETE".to_string()));
    }
    let mut text = String::new();
    let mut has_tool_call = false;
    for item in payload["output"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("message") => {
                if !matches!(item["status"].as_str(), None | Some("completed")) {
                    return Err(AppError::Ai("AI_RESPONSE_INCOMPLETE".to_string()));
                }
                for part in item["content"].as_array().into_iter().flatten() {
                    if part["type"].as_str() == Some("output_text") {
                        if let Some(value) = part["text"].as_str() {
                            text.push_str(value);
                        }
                    }
                }
            }
            Some("function_call") | Some("computer_call") | Some("web_search_call") => {
                has_tool_call = true
            }
            _ => {}
        }
    }
    Ok((text, has_tool_call))
}

fn emit_completed_response<R: Runtime>(
    app: &AppHandle<R>,
    event_name: &str,
    payload: &serde_json::Value,
    emitted: &AtomicBool,
    usage: &Mutex<Option<serde_json::Value>>,
) -> AppResult<()> {
    if !payload["error"].is_null() {
        return Err(crate::ai::stream_event_error(
            "OpenAI-compatible",
            &payload["error"],
        ));
    }
    if let Some(value) = payload.get("usage").filter(|value| !value.is_null()) {
        crate::ai::usage::merge_into(usage, value.clone());
    }
    let (text, has_tool_call) = response_output(payload)?;
    if text.trim().is_empty() {
        return Err(AppError::Ai(if has_tool_call {
            "AI_TOOL_CALL_UNSUPPORTED".to_string()
        } else {
            "AI_EMPTY_RESPONSE".to_string()
        }));
    }
    emitted.store(true, Ordering::Relaxed);
    let _ = app.emit(
        event_name,
        AiStreamChunk {
            delta: text,
            reasoning_delta: None,
            sources: None,
            done: false,
            error: None,
        },
    );
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
    Ok(())
}

fn process_data<R: Runtime>(
    app: &AppHandle<R>,
    event_name: &str,
    data: &str,
    emitted: &AtomicBool,
    usage: &Mutex<Option<serde_json::Value>>,
    state: &mut ResponseStreamState,
) -> AppResult<bool> {
    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|_| AppError::Ai("AI_STREAM_PROTOCOL_ERROR: invalid JSON event".to_string()))?;
    match parsed["type"].as_str().unwrap_or("") {
        "response.output_text.delta" => {
            // Skip empty deltas so a leading blank chunk doesn't block failover
            // to another credential (see the `emitted` gate in the router).
            if let Some(delta) = parsed["delta"].as_str().filter(|value| !value.is_empty()) {
                emitted.store(true, Ordering::Relaxed);
                if !delta.trim().is_empty() {
                    state.emitted_text = true;
                }
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
        "response.incomplete" => {
            return Err(AppError::Ai("AI_RESPONSE_INCOMPLETE".to_string()));
        }
        "response.completed" => {
            // Unlike chat/completions, the Responses API includes usage on
            // the completion event automatically — no `stream_options` opt-in
            // needed.
            if let Some(value) = parsed["response"].get("usage") {
                crate::ai::usage::merge_into(usage, value.clone());
            }
            let (final_text, has_tool_call) = response_output(&parsed["response"])?;
            if !state.emitted_text && !final_text.trim().is_empty() {
                emitted.store(true, Ordering::Relaxed);
                state.emitted_text = true;
                let _ = app.emit(
                    event_name,
                    AiStreamChunk {
                        delta: final_text,
                        reasoning_delta: None,
                        sources: None,
                        done: false,
                        error: None,
                    },
                );
            }
            if !state.emitted_text {
                return Err(AppError::Ai(if has_tool_call {
                    "AI_TOOL_CALL_UNSUPPORTED".to_string()
                } else {
                    "AI_EMPTY_RESPONSE".to_string()
                }));
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
            None,
            None,
        );
        assert_eq!(body["instructions"], "stable variable");
        assert_eq!(
            body["input"][0],
            serde_json::json!({ "role": "user", "content": "Question" })
        );
    }

    #[test]
    fn user_image_messages_become_input_image_parts_on_one_user_turn() {
        let body = request_body(
            "model",
            &[
                ChatMessage {
                    role: "user_image".into(),
                    content: "data:image/png;base64,AAA".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "extract the words".into(),
                },
            ],
            None,
            None,
            None,
        );
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        let parts = input[0]["content"].as_array().unwrap();
        assert_eq!(
            parts[0],
            serde_json::json!({ "type": "input_image", "image_url": "data:image/png;base64,AAA" })
        );
        assert_eq!(
            parts[1],
            serde_json::json!({ "type": "input_text", "text": "extract the words" })
        );
    }

    #[test]
    fn api_key_requests_preserve_configured_generation_parameters() {
        let body = request_body(
            "model",
            &[ChatMessage {
                role: "user".into(),
                content: "Question".into(),
            }],
            Some("high"),
            Some(0.35),
            Some(512),
        );
        assert_eq!(body["reasoning"], serde_json::json!({ "effort": "high" }));
        assert_eq!(body["temperature"], 0.35);
        assert_eq!(body["max_output_tokens"], 512);
    }

    #[test]
    fn failed_response_event_surfaces_provider_code() {
        let error = crate::ai::stream_event_error(
            "OpenAI",
            &serde_json::json!({ "type": "rate_limit_exceeded", "code": "rate_limit_exceeded" }),
        );
        assert!(error.to_string().contains("code=rate_limit_exceeded"));
    }

    #[test]
    fn completed_payload_text_is_extracted_and_incomplete_payload_is_rejected() {
        let completed = serde_json::json!({
            "status": "completed",
            "output": [{"type": "message", "status": "completed", "content": [
                {"type": "output_text", "text": "final only"}
            ]}]
        });
        assert_eq!(
            response_output(&completed).unwrap(),
            ("final only".to_string(), false)
        );
        let incomplete = serde_json::json!({"status": "incomplete", "output": []});
        assert!(response_output(&incomplete)
            .unwrap_err()
            .to_string()
            .contains("AI_RESPONSE_INCOMPLETE"));
    }

    #[test]
    fn tool_only_response_is_distinct_from_an_empty_response() {
        let tool = serde_json::json!({
            "status": "completed",
            "output": [{"type": "function_call", "name": "lookup", "arguments": "{}"}]
        });
        assert_eq!(response_output(&tool).unwrap(), (String::new(), true));
        let empty = serde_json::json!({"status": "completed", "output": []});
        assert_eq!(response_output(&empty).unwrap(), (String::new(), false));
    }
}
