use futures::StreamExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Runtime, Emitter};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

const MIN_CACHEABLE_STABLE_TOKENS: usize = 1_024;

/// Anthropic spells the levels without a separator (`xhigh`), while the
/// OpenAI-compatible world uses `x-high`. Lantern stores whatever the user
/// typed, so translate at the wire boundary instead of forcing one spelling on
/// the settings UI.
fn anthropic_effort(effort: &str) -> String {
    effort.replace('-', "")
}

fn request_body(
    model: &str,
    temperature: f64,
    messages: &[ChatMessage],
    max_tokens: Option<u32>,
    effort: Option<&str>,
) -> serde_json::Value {
    let stable = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<String>();
    let variable = messages
        .iter()
        .filter(|message| message.role == "system_cache_variable")
        .map(|message| message.content.as_str())
        .collect::<String>();
    let system = if crate::ai::grounding::chunk::estimate_tokens(&stable)
        >= MIN_CACHEABLE_STABLE_TOKENS
    {
        let mut blocks = vec![
            serde_json::json!({ "type": "text", "text": stable, "cache_control": { "type": "ephemeral" } }),
        ];
        if !variable.is_empty() {
            blocks.push(serde_json::json!({ "type": "text", "text": variable }));
        }
        serde_json::Value::Array(blocks)
    } else {
        serde_json::json!(format!("{stable}{variable}"))
    };
    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|message| !matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| serde_json::json!({ "role": message.role, "content": message.content }))
        .collect();
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens.unwrap_or(4096),
        "system": system,
        "messages": api_messages,
        "temperature": temperature,
        "stream": true,
    });
    match effort {
        // Anthropic has no `none` effort level; the way to ask for no thinking
        // is to disable it outright.
        Some("none") => {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        Some(effort) => {
            body["output_config"] = serde_json::json!({ "effort": anthropic_effort(effort) });
        }
        None => {}
    }
    body
}

#[allow(clippy::too_many_arguments)]
pub async fn stream_chat<R: Runtime>(
    app: &AppHandle<R>,
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    messages: &[ChatMessage],
    use_bearer_auth: bool,
    event_name: &str,
    max_tokens_override: Option<u32>,
    effort: Option<&str>,
    emitted: Arc<AtomicBool>,
) -> AppResult<()> {
    let client = crate::ai::http_client();
    let url = crate::ai::compat_endpoint(base_url, "messages");

    let body = request_body(model, temperature, messages, max_tokens_override, effort);

    let mut request = client
        .post(url)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");

    if use_bearer_auth {
        request = request.bearer_auth(api_key);
    } else {
        request = request.header("x-api-key", api_key);
    }

    let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.json(&body).send())
        .await
        .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
        .map_err(|e| AppError::Ai(e.to_string()))?;

    if !response.status().is_success() {
        return Err(crate::ai::http_status_error("Anthropic", response).await);
    }

    let mut stream = response.bytes_stream();
    let mut decoder = crate::ai::sse::SseDecoder::new();

    while let Some(chunk) = tokio::time::timeout(crate::ai::STREAM_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| AppError::Ai("AI_STREAM_IDLE_TIMEOUT".to_string()))?
    {
        let chunk = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        for data in decoder.push(&chunk)? {
            if process_data(app, event_name, &data, &emitted)? {
                return Ok(());
            }
        }
    }

    for data in decoder.finish()? {
        if process_data(app, event_name, &data, &emitted)? {
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
) -> AppResult<bool> {
    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|_| AppError::Ai("AI_STREAM_PROTOCOL_ERROR: invalid JSON event".to_string()))?;
    match parsed["type"].as_str().unwrap_or("") {
        "content_block_delta" => {
            if let Some(thinking) = parsed["delta"]["thinking"]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                emitted.store(true, Ordering::Relaxed);
                let _ = app.emit(
                    event_name,
                    AiStreamChunk {
                        delta: String::new(),
                        reasoning_delta: Some(thinking.to_string()),
                        sources: None,
                        done: false,
                        error: None,
                    },
                );
            }
            if let Some(text) = parsed["delta"]["text"]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                emitted.store(true, Ordering::Relaxed);
                let _ = app.emit(
                    event_name,
                    AiStreamChunk {
                        delta: text.to_string(),
                        reasoning_delta: None,
                        sources: None,
                        done: false,
                        error: None,
                    },
                );
            }
        }
        // Anthropic streams overloaded/rate-limit failures as an error event.
        // Surface the real code so the router cools the right credential rather
        // than reporting a generic AI_STREAM_INCOMPLETE.
        "error" => {
            return Err(crate::ai::stream_event_error("Anthropic", &parsed["error"]));
        }
        "message_stop" => {
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

    fn system(content: String, role: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content,
        }
    }

    #[test]
    fn cache_control_is_emitted_for_large_stable_prefixes() {
        let stable = "token ".repeat(1_100);
        let body = request_body(
            "model",
            0.2,
            &[
                system(stable, "system"),
                system(" excerpts".into(), "system_cache_variable"),
            ],
            None,
            None,
        );
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["system"][1]["text"], " excerpts");
    }

    #[test]
    fn small_prefix_keeps_one_uncached_system_string() {
        let body = request_body(
            "model",
            0.2,
            &[
                system("stable".into(), "system"),
                system(" variable".into(), "system_cache_variable"),
            ],
            None,
            None,
        );
        assert_eq!(body["system"], "stable variable");
    }

    #[test]
    fn full_text_stable_prefix_is_cacheable_without_a_variable_suffix() {
        let body = request_body(
            "model",
            0.2,
            &[system("token ".repeat(1_100), "system")],
            None,
            None,
        );
        assert_eq!(body["system"].as_array().unwrap().len(), 1);
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn reasoning_effort_uses_the_anthropic_spelling() {
        let body = request_body(
            "model",
            0.2,
            &[system("stable".into(), "system")],
            None,
            Some("x-high"),
        );
        assert_eq!(body["output_config"]["effort"], "xhigh");
        assert!(body["thinking"].is_null());
    }

    #[test]
    fn none_effort_disables_thinking_instead_of_sending_a_level() {
        // Anthropic rejects `effort: "none"`; the equivalent request is one
        // that turns thinking off.
        let body = request_body(
            "model",
            0.2,
            &[system("stable".into(), "system")],
            None,
            Some("none"),
        );
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body["output_config"].is_null());
    }

    #[test]
    fn error_event_surfaces_provider_code() {
        let error = crate::ai::stream_event_error(
            "Anthropic",
            &serde_json::json!({ "type": "overloaded_error" }),
        );
        assert!(error.to_string().contains("type=overloaded_error"));
    }
}
