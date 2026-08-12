use futures::StreamExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Runtime};

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

/// Rewrites a plain-string `"content"` field into the array form carrying an
/// `ephemeral` `cache_control` breakpoint. Anthropic reads a breakpoint as
/// "cache everything up to and including this block," so each call site
/// below is choosing where a shared prefix ends, not just marking "this one
/// message."
fn mark_cache_control(message: &mut serde_json::Value) {
    let text = message["content"].as_str().unwrap_or_default().to_string();
    message["content"] = serde_json::json!([
        { "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }
    ]);
}

fn request_body(
    model: &str,
    temperature: f64,
    messages: &[ChatMessage],
    max_tokens: Option<u32>,
    effort: Option<&str>,
    // Explicit per-call cache request (quiz generation's two-phase pipeline —
    // see docs/impls/cijuan-merge.md §二.6 — and any other multi-turn caller
    // that wants its earlier turns read from cache): marks the last message
    // with `cache_control`, and rides along on the system prompt too when
    // there is one, even if it is below the size-based auto-cache threshold
    // below. Independent of that threshold — a caller can ask for this on a
    // short system prompt, and a long system prompt still auto-caches with
    // this left `false`.
    //
    // Two message-level breakpoints, not one, when there's an assistant turn
    // to put the second one on (see below) — quiz generation's pipeline is
    // 出题 → 明答校验（续写）→ 解析生成（分叉续写：same conversation, but the
    // final user message differs from the 明答校验 branch's). Both forked
    // calls need a breakpoint at the assistant message they share as their
    // last common turn, or neither branch's cache read reaches past it — a
    // breakpoint only on each branch's own (different) final message would
    // cache nothing in common between them. Anthropic allows up to 4
    // breakpoints per request; this uses at most 3 (system + shared-prefix
    // assistant turn + final message).
    cache_last_message: bool,
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
    let cache_system = !stable.is_empty()
        && (crate::ai::grounding::chunk::estimate_tokens(&stable) >= MIN_CACHEABLE_STABLE_TOKENS
            || cache_last_message);
    let system = if cache_system {
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
    let mut api_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|message| !matches!(message.role.as_str(), "system" | "system_cache_variable"))
        .map(|message| serde_json::json!({ "role": message.role, "content": message.content }))
        .collect();
    if cache_last_message {
        let len = api_messages.len();
        if len > 0 {
            // The last assistant turn *before* the final message is the
            // shared-prefix breakpoint a forked continuation needs (see the
            // doc comment on `cache_last_message` above). Searching only
            // `[..len - 1]` means: if the final message already *is* an
            // assistant turn, it only gets marked once, by the final-message
            // branch below, rather than twice.
            if let Some(index) = api_messages[..len - 1]
                .iter()
                .enumerate()
                .rev()
                .find(|(_, message)| message["role"] == "assistant")
                .map(|(index, _)| index)
            {
                mark_cache_control(&mut api_messages[index]);
            }
            mark_cache_control(&mut api_messages[len - 1]);
        }
    }
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
    cache_last_message: bool,
    emitted: Arc<AtomicBool>,
    usage: Arc<Mutex<Option<serde_json::Value>>>,
) -> AppResult<()> {
    let client = crate::ai::http_client();
    let url = crate::ai::compat_endpoint(base_url, "messages");

    let body = request_body(
        model,
        temperature,
        messages,
        max_tokens_override,
        effort,
        cache_last_message,
    );

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
        // Anthropic splits usage across two events: `message_start` carries
        // input tokens (and any cache accounting), `message_delta` carries
        // the final output token count once generation stops. Both get
        // merged into the same accumulator — see `usage::merge_into`.
        "message_start" => {
            if let Some(value) = parsed["message"].get("usage") {
                crate::ai::usage::merge_into(usage, value.clone());
            }
        }
        "message_delta" => {
            if let Some(value) = parsed.get("usage") {
                crate::ai::usage::merge_into(usage, value.clone());
            }
        }
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
            false,
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
            false,
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
            false,
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
            false,
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
            false,
        );
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body["output_config"].is_null());
    }

    #[test]
    fn cache_last_message_marks_the_final_turn_even_without_a_system_prompt() {
        let body = request_body(
            "model",
            0.2,
            &[
                ChatMessage {
                    role: "user".into(),
                    content: "first turn".into(),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: "first reply".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "second turn".into(),
                },
            ],
            None,
            None,
            true,
        );
        // No system messages at all: there is nothing to cache there, but the
        // last message still gets marked.
        assert_eq!(body["system"], "");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "first turn");
        // The lone assistant turn sits before the final message, so it gets
        // its own breakpoint too — the shared-prefix mark a forked
        // continuation needs (see `cache_last_message`'s doc comment).
        assert_eq!(messages[1]["content"][0]["text"], "first reply");
        assert_eq!(
            messages[1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(messages[2]["content"][0]["text"], "second turn");
        assert_eq!(
            messages[2]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn cache_last_message_also_caches_a_system_prompt_below_the_size_threshold() {
        // The size-based auto-cache (`cache_control_is_emitted_for_large_stable_prefixes`)
        // only kicks in past `MIN_CACHEABLE_STABLE_TOKENS`. An explicit cache
        // request rides along on a short system prompt too, since the caller
        // (e.g. quiz generation's two-phase pipeline) knows it will be reread
        // on the very next turn regardless of size.
        let body = request_body(
            "model",
            0.2,
            &[
                system("short and stable".into(), "system"),
                ChatMessage {
                    role: "assistant".into(),
                    content: "phase one output".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "now write the explanations".into(),
                },
            ],
            None,
            None,
            true,
        );
        assert_eq!(body["system"][0]["text"], "short and stable");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let messages = body["messages"].as_array().unwrap();
        // Same shared-prefix marking as above: the assistant turn ("phase
        // one output") is also the last common turn a forked continuation
        // (e.g. 明答校验 vs. 解析生成, both continuing from here) would need
        // a breakpoint on.
        assert_eq!(messages[0]["content"][0]["text"], "phase one output");
        assert_eq!(
            messages[0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(
            messages[1]["content"][0]["text"],
            "now write the explanations"
        );
        assert_eq!(
            messages[1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn cache_last_message_leaves_earlier_assistant_turns_unmarked() {
        // Three assistant turns; only the last one (the shared-prefix
        // breakpoint) and the final message should get `cache_control` — an
        // earlier assistant turn is not a fork point any caller in this
        // pipeline needs, and marking it would spend one of Anthropic's 4
        // breakpoints on nothing.
        let body = request_body(
            "model",
            0.2,
            &[
                ChatMessage {
                    role: "user".into(),
                    content: "turn 1".into(),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: "reply 1".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "turn 2".into(),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: "reply 2".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "turn 3".into(),
                },
            ],
            None,
            None,
            true,
        );
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "turn 1");
        assert_eq!(messages[1]["content"], "reply 1");
        assert_eq!(messages[2]["content"], "turn 2");
        assert_eq!(messages[3]["content"][0]["text"], "reply 2");
        assert_eq!(
            messages[3]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(messages[4]["content"][0]["text"], "turn 3");
        assert_eq!(
            messages[4]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn cache_last_message_does_not_double_mark_when_the_final_message_is_itself_assistant() {
        let body = request_body(
            "model",
            0.2,
            &[
                ChatMessage {
                    role: "user".into(),
                    content: "turn 1".into(),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: "reply 1".into(),
                },
            ],
            None,
            None,
            true,
        );
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "turn 1");
        // Only one breakpoint: the final message, marked once, not twice.
        assert_eq!(messages[1]["content"][0]["text"], "reply 1");
        assert_eq!(
            messages[1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert_eq!(messages[1]["content"].as_array().unwrap().len(), 1);
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
