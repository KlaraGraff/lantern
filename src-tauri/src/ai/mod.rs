pub mod anthropic;
pub mod grounding;
pub mod oauth;
pub mod openai_compat;
pub mod openai_responses;
pub mod router;
mod sse;

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
    mut response: reqwest::Response,
) -> crate::error::AppError {
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
    let (error_type, error_code) = serde_json::from_slice::<serde_json::Value>(&body)
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
    use super::compat_endpoint;

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
