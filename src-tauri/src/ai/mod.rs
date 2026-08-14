pub mod anthropic;
pub mod grounding;
pub mod oauth;
pub mod openai_compat;
pub mod openai_responses;
pub mod request_counts;
pub mod router;
mod sse;
pub mod usage;

use std::sync::OnceLock;
use std::time::Duration;

/// Shared transport with bounded connection setup. Individual adapters also
/// enforce a first-byte and stream-idle timeout, rather than a total timeout
/// that would cut off legitimate long responses.
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("build shared AI HTTP client")
    })
}

pub(crate) const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(75);
const MAX_PROVIDER_ERROR_BYTES: usize = 64 * 1024;

/// The image formats every wired provider family accepts as base64 input.
/// Doubles as the allow-list `ai_complete_text` validates `user_image`
/// messages against, so a typo'd or exotic media type fails at the command
/// boundary instead of as an opaque provider 400.
const IMAGE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// Split a `data:image/...;base64,...` URI into `(media_type, base64_data)`.
/// `None` for anything that isn't a well-formed data URI of an allowed image
/// type — callers treat that as invalid input, never as text to send.
pub(crate) fn parse_image_data_uri(content: &str) -> Option<(&str, &str)> {
    let rest = content.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    if !IMAGE_MEDIA_TYPES.contains(&media_type) || data.is_empty() {
        return None;
    }
    Some((media_type, data))
}

/// One outgoing API message after in-band `user_image` merging.
///
/// `user_image` follows the `system_cache_variable` precedent: a role that
/// exists only inside Lantern's `Vec<ChatMessage>` and is translated away at
/// the wire boundary. Each provider's `request_body` turns an entry with
/// images into its own multimodal content-parts shape; an entry without
/// images stays a plain string so image-free requests are byte-identical to
/// what they were before this channel existed.
pub(crate) struct ApiMessage<'a> {
    pub role: &'a str,
    pub text: &'a str,
    /// Data URIs in original order; non-empty only on merged user messages.
    pub images: Vec<&'a str>,
}

/// Fold `user_image` messages into the next `user` turn (images first, text
/// after), so providers with strict user/assistant alternation (Anthropic)
/// still see one user message. Images not followed by a `user` turn — a
/// trailing image, or one oddly placed before an `assistant` turn — are
/// flushed as their own image-only user message rather than reordered past
/// other turns.
pub(crate) fn merge_image_messages<'a>(
    messages: impl Iterator<Item = &'a crate::commands::ai::ChatMessage>,
) -> Vec<ApiMessage<'a>> {
    let mut out: Vec<ApiMessage<'a>> = Vec::new();
    let mut pending: Vec<&'a str> = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "user_image" => pending.push(message.content.as_str()),
            "user" => out.push(ApiMessage {
                role: "user",
                text: &message.content,
                images: std::mem::take(&mut pending),
            }),
            role => {
                if !pending.is_empty() {
                    out.push(ApiMessage {
                        role: "user",
                        text: "",
                        images: std::mem::take(&mut pending),
                    });
                }
                out.push(ApiMessage {
                    role,
                    text: &message.content,
                    images: Vec::new(),
                });
            }
        }
    }
    if !pending.is_empty() {
        out.push(ApiMessage {
            role: "user",
            text: "",
            images: pending,
        });
    }
    out
}

/// Join a provider base URL with a path such as `chat/completions`.
///
/// Providers publish the base URL either with the version segment already in it
/// (`https://host.example/api/paas/v4`) or without one
/// (`https://api.openai.com`). Appending `/v1` unconditionally turned the former
/// into `/api/paas/v4/v1/chat/completions`, so any base whose path already ends
/// in a version segment is taken as complete. Matching `v<digits>` rather than
/// the literal `/v1` keeps `/v4` and any future version working without a
/// per-provider special case.
///
/// Every OpenAI-shaped request — chat, model list, embeddings, connection test —
/// goes through here so the rule cannot drift between them.
pub(crate) fn compat_endpoint(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if ends_with_version_segment(base) {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    }
}

fn ends_with_version_segment(base: &str) -> bool {
    // Only the path counts: a host such as `v4.example.com` is not a version.
    let after_scheme = base.split_once("://").map_or(base, |(_, rest)| rest);
    let Some((_, path)) = after_scheme.split_once('/') else {
        return false;
    };
    path.rsplit('/').next().is_some_and(|segment| {
        segment
            .strip_prefix('v')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn retry_after_seconds(value: &str) -> Option<i64> {
    if let Ok(seconds) = value.trim().parse::<i64>() {
        return Some(seconds.clamp(1, 86_400));
    }
    chrono::DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|deadline| {
            (deadline.timestamp_millis() - chrono::Utc::now().timestamp_millis()) / 1000
        })
        .map(|seconds| seconds.clamp(1, 86_400))
}

/// Preserve rate-limit hints for the credential router without exposing
/// provider response bodies or credentials to the WebView.
pub(crate) async fn http_status_error(
    provider: &str,
    response: reqwest::Response,
) -> crate::error::AppError {
    let (status, retry_after, body) = read_error_response(response).await;
    http_status_error_from_body(provider, status, retry_after, &body)
}

/// Drain a failed response into the parts [`http_status_error_from_body`]
/// needs, bounded by `MAX_PROVIDER_ERROR_BYTES`.
///
/// Split out for the one caller that has to read the provider's own error
/// text before deciding what the failure means — `openai_compat`, working out
/// whether a 400 is blaming the `stream_options` key it sent — and which then
/// still has to be able to produce the identical error it would have.
pub(crate) async fn read_error_response(
    mut response: reqwest::Response,
) -> (reqwest::StatusCode, Option<i64>, Vec<u8>) {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(retry_after_seconds);
    let mut body = Vec::new();
    while body.len() < MAX_PROVIDER_ERROR_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = MAX_PROVIDER_ERROR_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    (status, retry_after, body)
}

/// The body-consuming half of [`http_status_error`]. Emits only the
/// provider's `type`/`code` — never its free-text message, which can quote
/// the prompt back.
pub(crate) fn http_status_error_from_body(
    provider: &str,
    status: reqwest::StatusCode,
    retry_after: Option<i64>,
    body: &[u8],
) -> crate::error::AppError {
    let (error_type, error_code) = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .map(|value| {
            let error = value.get("error").unwrap_or(&value);
            (
                sanitized_error_field(error.get("type")),
                sanitized_error_field(error.get("code")),
            )
        })
        .unwrap_or_default();
    let hint = retry_after
        .map(|seconds| format!(" retry-after={seconds}"))
        .unwrap_or_default();
    let error_type = error_type
        .map(|value| format!(" type={value}"))
        .unwrap_or_default();
    let error_code = error_code
        .map(|value| format!(" code={value}"))
        .unwrap_or_default();
    crate::error::AppError::Ai(format!(
        "AI_PROVIDER_HTTP provider={provider} status={}{}{}{hint}",
        status.as_u16(),
        error_type,
        error_code,
    ))
}

/// Build an `AppError` from an error object delivered *inside* an SSE stream
/// (the top-level `error` field of an OpenAI-style error event, or the `error`
/// of an Anthropic `{"type":"error",...}` event). Mirrors `http_status_error`'s
/// `type=`/`code=` shape so `classify_error` routes it (rate_limit, quota,
/// auth, content policy, …) instead of the stream ending as a generic
/// `AI_STREAM_INCOMPLETE` with the real code lost.
pub(crate) fn stream_event_error(
    provider: &str,
    error: &serde_json::Value,
) -> crate::error::AppError {
    let error_type = sanitized_error_field(error.get("type"))
        .map(|value| format!(" type={value}"))
        .unwrap_or_default();
    let error_code = sanitized_error_field(error.get("code"))
        .map(|value| format!(" code={value}"))
        .unwrap_or_default();
    crate::error::AppError::Ai(format!(
        "AI_STREAM_PROVIDER_ERROR provider={provider}{error_type}{error_code}"
    ))
}

fn sanitized_error_field(value: Option<&serde_json::Value>) -> Option<String> {
    let value = match value? {
        serde_json::Value::String(value) => value.as_str(),
        serde_json::Value::Number(value) => return Some(value.to_string()),
        _ => return None,
    };
    let sanitized: String = value
        .chars()
        .take(80)
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .collect();
    (!sanitized.is_empty()).then_some(sanitized)
}

#[cfg(test)]
mod tests {
    use super::{compat_endpoint, merge_image_messages, parse_image_data_uri};
    use crate::commands::ai::ChatMessage;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn parses_allowed_image_data_uris() {
        assert_eq!(
            parse_image_data_uri("data:image/jpeg;base64,abc123"),
            Some(("image/jpeg", "abc123"))
        );
        assert_eq!(
            parse_image_data_uri("data:image/png;base64,xyz"),
            Some(("image/png", "xyz"))
        );
    }

    #[test]
    fn rejects_malformed_or_disallowed_data_uris() {
        // Not a data URI at all; text must never be mistaken for an image.
        assert_eq!(parse_image_data_uri("hello words"), None);
        // Right scheme, missing payload.
        assert_eq!(parse_image_data_uri("data:image/jpeg;base64,"), None);
        // Non-image and not-allow-listed media types.
        assert_eq!(parse_image_data_uri("data:application/pdf;base64,aa"), None);
        assert_eq!(parse_image_data_uri("data:image/tiff;base64,aa"), None);
        // Not base64-marked.
        assert_eq!(parse_image_data_uri("data:image/png,plain"), None);
    }

    #[test]
    fn images_fold_into_the_following_user_turn_in_order() {
        let messages = [
            message("user_image", "data:image/png;base64,one"),
            message("user_image", "data:image/png;base64,two"),
            message("user", "what words are in these?"),
        ];
        let merged = merge_image_messages(messages.iter());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].role, "user");
        assert_eq!(merged[0].text, "what words are in these?");
        assert_eq!(
            merged[0].images,
            vec!["data:image/png;base64,one", "data:image/png;base64,two"]
        );
    }

    #[test]
    fn a_trailing_image_becomes_its_own_user_message() {
        let messages = [
            message("user", "first"),
            message("user_image", "data:image/png;base64,late"),
        ];
        let merged = merge_image_messages(messages.iter());
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].text, "first");
        assert!(merged[0].images.is_empty());
        assert_eq!(merged[1].role, "user");
        assert_eq!(merged[1].text, "");
        assert_eq!(merged[1].images, vec!["data:image/png;base64,late"]);
    }

    #[test]
    fn an_image_before_an_assistant_turn_flushes_instead_of_reordering() {
        let messages = [
            message("user_image", "data:image/png;base64,img"),
            message("assistant", "earlier reply"),
            message("user", "follow-up"),
        ];
        let merged = merge_image_messages(messages.iter());
        assert_eq!(
            merged.iter().map(|m| m.role).collect::<Vec<_>>(),
            vec!["user", "assistant", "user"]
        );
        assert_eq!(merged[0].images, vec!["data:image/png;base64,img"]);
        assert!(merged[2].images.is_empty());
    }

    #[test]
    fn image_free_conversations_pass_through_unchanged() {
        let messages = [message("user", "q"), message("assistant", "a")];
        let merged = merge_image_messages(messages.iter());
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().all(|m| m.images.is_empty()));
    }

    #[test]
    fn appends_v1_when_base_has_no_version() {
        assert_eq!(
            compat_endpoint("https://api.openai.com", "chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            compat_endpoint("https://api.anthropic.com", "messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn keeps_an_existing_version_segment() {
        assert_eq!(
            compat_endpoint("https://host.example/v1", "chat/completions"),
            "https://host.example/v1/chat/completions"
        );
        // A version segment below the root, and not `/v1`: the shape that used
        // to come back as `/api/paas/v4/v1/chat/completions`.
        assert_eq!(
            compat_endpoint("https://host.example/api/paas/v4", "chat/completions"),
            "https://host.example/api/paas/v4/chat/completions"
        );
        assert_eq!(
            compat_endpoint("https://gateway.example/v3", "chat/completions"),
            "https://gateway.example/v3/chat/completions"
        );
    }

    #[test]
    fn covers_every_path_the_callers_use() {
        for path in ["chat/completions", "models", "embeddings", "messages"] {
            assert_eq!(
                compat_endpoint("https://host.example/api/paas/v4", path),
                format!("https://host.example/api/paas/v4/{path}")
            );
            assert_eq!(
                compat_endpoint("https://api.openai.com", path),
                format!("https://api.openai.com/v1/{path}")
            );
        }
    }

    #[test]
    fn ignores_trailing_slashes_and_surrounding_space() {
        for base in [
            "https://host.example/api/paas/v4/",
            "  https://host.example/api/paas/v4  ",
            "https://host.example/api/paas/v4///",
        ] {
            assert_eq!(
                compat_endpoint(base, "embeddings"),
                "https://host.example/api/paas/v4/embeddings"
            );
        }
    }

    #[test]
    fn a_version_shaped_host_is_not_a_version_segment() {
        assert_eq!(
            compat_endpoint("https://v4.example.com", "models"),
            "https://v4.example.com/v1/models"
        );
        assert_eq!(
            compat_endpoint("http://localhost:11434", "models"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn a_segment_that_merely_starts_with_v_is_not_a_version() {
        assert_eq!(
            compat_endpoint("https://host.example/vision", "models"),
            "https://host.example/vision/v1/models"
        );
        assert_eq!(
            compat_endpoint("https://host.example/v", "models"),
            "https://host.example/v/v1/models"
        );
        assert_eq!(
            compat_endpoint("https://host.example/v1beta", "models"),
            "https://host.example/v1beta/v1/models"
        );
    }
}
