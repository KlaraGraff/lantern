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
    temperature: f64,
    messages: &[ChatMessage],
    keep_alive: Option<&str>,
    max_tokens_override: Option<u32>,
    effort: Option<&str>,
) -> serde_json::Value {
    // Grounded chat internally separates cacheable and variable system text.
    // OpenAI-compatible APIs receive the original single combined message.
    let system = messages
        .iter()
        .filter(|message| matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| message.content.as_str())
        .collect::<String>();
    let mut api_messages = Vec::new();
    if !system.is_empty() {
        api_messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    api_messages.extend(
        crate::ai::merge_image_messages(messages.iter().filter(|message| {
            !matches!(message.role.as_str(), "system" | "system_cache_variable")
        }))
        .into_iter()
        .map(|message| {
            if message.images.is_empty() {
                // Image-free messages keep plain-string content — the shape
                // every compatible server, however strict, already accepts.
                return serde_json::json!({ "role": message.role, "content": message.text });
            }
            let mut parts: Vec<serde_json::Value> = message
                .images
                .iter()
                .map(|uri| serde_json::json!({ "type": "image_url", "image_url": { "url": uri } }))
                .collect();
            if !message.text.is_empty() {
                parts.push(serde_json::json!({ "type": "text", "text": message.text }));
            }
            serde_json::json!({ "role": "user", "content": parts })
        }),
    );
    let mut body = serde_json::json!({
        "model": model,
        "messages": api_messages,
        "temperature": temperature,
        "stream": true,
        // Ask for a final usage-bearing chunk. OpenAI and DeepSeek honor it;
        // Ollama ignores it (ollama/ollama#4448). A stricter compatible
        // server may instead reject the whole request for naming a parameter
        // it does not know — `stream_chat` retries without this key when a
        // 400 body names it, because losing usage stats is acceptable and
        // losing the reader's AI entirely is not.
        "stream_options": { "include_usage": true },
    });
    if let Some(keep_alive) = keep_alive {
        body["keep_alive"] = serde_json::json!(keep_alive);
    }
    if let Some(max_tokens) = max_tokens_override {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    if let Some(effort) = effort {
        body["reasoning_effort"] = serde_json::json!(effort);
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
    keep_alive: Option<&str>,
    event_name: &str,
    max_tokens_override: Option<u32>,
    effort: Option<&str>,
    emitted: Arc<AtomicBool>,
    usage: Arc<Mutex<Option<serde_json::Value>>>,
) -> AppResult<()> {
    let client = crate::ai::http_client();
    let url = crate::ai::compat_endpoint(base_url, "chat/completions");

    // "OpenAI-compatible" covers everything from OpenAI itself to a local
    // llama.cpp build, and they disagree about unknown request keys: most
    // ignore them, some reject the request outright. `stream_options` is the
    // only key here that a server might not know, and it exists purely to get
    // token counts back — so when a 400 body actually names it, one extra
    // round trip without the key beats leaving the reader with an AI service
    // that fails on every call.
    //
    // The check is on the body naming the key, not merely on the status:
    // every other 400 is a request the provider refused on its shape (context
    // too long, unsupported parameter, blocked content), and re-sending those
    // bytes is a second billed call that gets refused identically. That is
    // also why the router treats a 400 as the end of the route rather than a
    // reason to tour the remaining credentials.
    let mut ask_for_usage = true;
    let response = loop {
        let mut body = request_body(
            model,
            temperature,
            messages,
            keep_alive,
            max_tokens_override,
            effort,
        );
        if !ask_for_usage {
            if let Some(object) = body.as_object_mut() {
                object.remove("stream_options");
            }
        }

        let mut request = client.post(&url).json(&body);
        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }

        let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.send())
            .await
            .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
            .map_err(|e| AppError::Ai(e.to_string()))?;

        if response.status().is_success() {
            break response;
        }

        let (status, retry_after, error_body) = crate::ai::read_error_response(response).await;
        if ask_for_usage
            && status == reqwest::StatusCode::BAD_REQUEST
            && String::from_utf8_lossy(&error_body).contains("stream_options")
        {
            ask_for_usage = false;
            continue;
        }
        return Err(crate::ai::http_status_error_from_body(
            "OpenAI-compatible",
            status,
            retry_after,
            &error_body,
        ));
    };

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

/// The parts of one SSE delta the reader can actually see, as
/// `(reasoning, content)`.
///
/// Empty strings are dropped rather than returned: some gateways send a leading
/// empty chunk before erroring, and treating that as output would freeze the
/// route on a model that never said anything. A non-empty reasoning delta is
/// output — the reader is watching it arrive — so it does stop the switch, even
/// though no answer has started.
fn visible_output(choice_delta: &serde_json::Value) -> (Option<&str>, Option<&str>) {
    let reasoning = choice_delta["reasoning_content"]
        .as_str()
        .or_else(|| choice_delta["reasoning"].as_str())
        .or_else(|| choice_delta["thinking"].as_str())
        .filter(|value| !value.is_empty());
    let content = choice_delta["content"]
        .as_str()
        .filter(|value| !value.is_empty());
    (reasoning, content)
}

fn process_data<R: Runtime>(
    app: &AppHandle<R>,
    event_name: &str,
    data: &str,
    emitted: &AtomicBool,
    usage: &Mutex<Option<serde_json::Value>>,
) -> AppResult<bool> {
    if data == "[DONE]" {
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

    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|_| AppError::Ai("AI_STREAM_PROTOCOL_ERROR: invalid JSON event".to_string()))?;
    // A mid-stream error event carries the real reason (rate limit, quota,
    // content policy). Surface it so the router can cool the right credential
    // instead of treating the truncated stream as AI_STREAM_INCOMPLETE.
    if !parsed["error"].is_null() {
        return Err(crate::ai::stream_event_error(
            "OpenAI-compatible",
            &parsed["error"],
        ));
    }
    // The usage-bearing final chunk (from `stream_options.include_usage`)
    // carries `usage` at the top level, typically alongside an empty
    // `choices` array — indexing that below is null-safe either way.
    if let Some(value) = parsed.get("usage").filter(|value| !value.is_null()) {
        crate::ai::usage::merge_into(usage, value.clone());
    }
    let (reasoning, content) = visible_output(&parsed["choices"][0]["delta"]);
    if let Some(reasoning) = reasoning {
        emitted.store(true, Ordering::Relaxed);
        let _ = app.emit(
            event_name,
            AiStreamChunk {
                delta: String::new(),
                reasoning_delta: Some(reasoning.to_string()),
                sources: None,
                done: false,
                error: None,
            },
        );
    }
    if let Some(delta) = content {
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
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separated_system_content_is_sent_as_one_byte_identical_message() {
        let body = request_body(
            "model",
            0.2,
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
        assert_eq!(
            body["messages"][0],
            serde_json::json!({ "role": "system", "content": "stable variable" })
        );
        assert_eq!(
            body["messages"][1],
            serde_json::json!({ "role": "user", "content": "Question" })
        );
    }

    #[test]
    fn user_image_messages_become_image_url_parts_on_one_user_turn() {
        let body = request_body(
            "model",
            0.2,
            &[
                ChatMessage {
                    role: "user_image".into(),
                    content: "data:image/jpeg;base64,AAA".into(),
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
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        let parts = messages[0]["content"].as_array().unwrap();
        assert_eq!(
            parts[0],
            serde_json::json!({
                "type": "image_url",
                "image_url": { "url": "data:image/jpeg;base64,AAA" }
            })
        );
        assert_eq!(
            parts[1],
            serde_json::json!({ "type": "text", "text": "extract the words" })
        );
    }

    #[test]
    fn empty_deltas_are_not_output_and_never_block_a_model_switch() {
        // Some gateways open with an empty chunk and then error. Counting that
        // as output would strand the request on a model that said nothing.
        let delta = serde_json::json!({
            "role": "assistant", "content": "", "reasoning_content": ""
        });
        let (reasoning, content) = visible_output(&delta);
        assert_eq!(reasoning, None);
        assert_eq!(content, None);

        // Protocol metadata alone is not output either.
        let delta = serde_json::json!({ "role": "assistant" });
        let (reasoning, content) = visible_output(&delta);
        assert_eq!(reasoning, None);
        assert_eq!(content, None);
    }

    /// Locks §5.3: a non-empty reasoning delta counts as output. The reader is
    /// already watching it, and a second model's thinking spliced onto the
    /// first would read as two unrelated trains of thought.
    #[test]
    fn non_empty_reasoning_counts_as_output_under_every_spelling() {
        for field in ["reasoning_content", "reasoning", "thinking"] {
            let delta = serde_json::json!({ field: "weighing the options" });
            let (reasoning, content) = visible_output(&delta);
            assert_eq!(reasoning, Some("weighing the options"), "{field}");
            assert_eq!(content, None, "{field}");
        }
    }

    #[test]
    fn mid_stream_error_event_surfaces_provider_code() {
        // A gateway can send a rate-limit error mid-stream. It must become a
        // classified error, not be swallowed into AI_STREAM_INCOMPLETE.
        let error = crate::ai::stream_event_error(
            "OpenAI-compatible",
            &serde_json::json!({ "type": "rate_limit_error", "code": "rate_limited" }),
        );
        let message = error.to_string();
        assert!(message.contains("type=rate_limit_error"));
        assert!(message.contains("code=rate_limited"));
    }
}
