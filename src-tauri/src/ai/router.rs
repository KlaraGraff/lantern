//! Provider-neutral AI request routing and API credential failover.
//!
//! Secret values never leave the Rust backend. Profile metadata stores only a
//! local secret reference, masked suffix, priority, and health state.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use chrono::Utc;
use futures::StreamExt;
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Listener, Runtime};
use tokio::sync::watch;

use crate::commands::ai::ChatMessage;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AiProfileView {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub auth_mode: String,
    pub base_url: Option<String>,
    pub model: String,
    pub temperature: f64,
    /// `None` means "send no reasoning parameter", which is not the same as the
    /// literal value `none` (an explicit "do not think" some providers accept).
    pub reasoning_effort: Option<String>,
    /// Off keeps the effort on the chat path only; on extends it to the short
    /// utility completions that share this profile.
    pub reasoning_effort_all_features: bool,
    pub keep_alive: Option<String>,
    pub enabled: bool,
    pub priority: i64,
    pub state: String,
    pub cooldown_until: Option<i64>,
    pub last_error_kind: Option<String>,
    pub last_used_at: Option<i64>,
    pub last_latency_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AiCredentialView {
    pub id: String,
    pub profile_id: String,
    pub label: String,
    pub masked_suffix: String,
    pub enabled: bool,
    pub priority: i64,
    pub state: String,
    pub cooldown_until: Option<i64>,
    pub last_error_kind: Option<String>,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiConnectionTestResult {
    pub success: bool,
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_response_ms: Option<u64>,
    pub total_ms: u64,
    pub tested_at: i64,
    pub attempt_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    pub attempts: Vec<AiConnectionTestAttempt>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiConnectionTestAttempt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    pub latency_ms: u64,
    pub request_sent: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiCompletion {
    pub text: String,
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_token_ms: Option<u64>,
    pub total_ms: u64,
}

#[derive(Debug, Clone)]
struct AiProfile {
    view: AiProfileView,
}

#[derive(Debug, Clone)]
struct AiCredential {
    view: AiCredentialView,
    secret_ref: String,
}

type NormalizedProfileConfig = (
    String,
    String,
    String,
    Option<String>,
    String,
    f64,
    Option<String>,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiErrorKind {
    Cancelled,
    CredentialInvalid,
    Auth,
    Permission,
    RateLimit,
    Quota,
    Network,
    Provider5xx,
    Protocol,
    Request,
    NotConfigured,
}

impl AiErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::CredentialInvalid => "credential_invalid",
            Self::Auth => "auth",
            Self::Permission => "permission",
            Self::RateLimit => "rate_limit",
            Self::Quota => "quota",
            Self::Network => "network",
            Self::Provider5xx => "provider_5xx",
            Self::Protocol => "protocol",
            Self::Request => "request",
            Self::NotConfigured => "not_configured",
        }
    }

    fn retryable(self) -> bool {
        matches!(
            self,
            Self::CredentialInvalid
                | Self::Auth
                | Self::Permission
                | Self::RateLimit
                | Self::Quota
                | Self::Network
                | Self::Provider5xx
                | Self::Protocol
        )
    }
}

/// Codes that mean this key is not a key any more. Matched on `code=` only:
/// Anthropic also sends `type=authentication_error` for a transient auth
/// failure, and marking a working key permanently invalid is worse than the
/// five-minute cooldown the `Auth` class gives it.
const CREDENTIAL_INVALID_CODES: [&str; 6] = [
    "invalid_api_key",
    "invalid_api_key_error",
    "authentication_error",
    "invalid_x_api_key",
    "api_key_revoked",
    "key_revoked",
];

const POLICY_CODES: [&str; 4] = [
    "content_policy_violation",
    "content_filter",
    "moderation_blocked",
    "safety_violation",
];

/// Codes that mean the account is out of allowance rather than going too fast.
/// Providers send them on 429 as often as on 402 — OpenAI's `insufficient_quota`
/// is a 429 — so they are read before the status is. A spent quota put on a
/// one-minute rate-limit cooldown just fails again a minute later.
const QUOTA_CODES: [&str; 6] = [
    "insufficient_quota",
    "insufficient_user_quota",
    "quota_exceeded",
    "credit_balance_too_low",
    "billing_hard_limit_reached",
    "billing_not_active",
];

/// The prose fallback for providers that send no machine code at all. Narrow on
/// purpose: the old rule matched bare `insufficient`, which swallowed
/// "insufficient permissions" and sidelined a working key for an hour.
const QUOTA_PHRASES: [&str; 6] = [
    "quota",
    "insufficient credit",
    "insufficient balance",
    "insufficient funds",
    "credit balance too low",
    "out of credits",
];

/// The wire status carried in the message, if it has one.
///
/// `http_status_error` formats it as `status=NNN`, so reading the number back
/// once beats matching a substring per code — and it means a status nobody
/// listed (Anthropic's 529 `overloaded_error`, a gateway's 520) still lands
/// with the rest of its class instead of falling through to `Network`.
fn status_code(message: &str) -> Option<u16> {
    let rest = &message[message.find("status=")? + "status=".len()..];
    rest.chars()
        .take_while(|value| value.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

fn classify_error(error: &AppError) -> AiErrorKind {
    let message = error.to_string().to_ascii_lowercase();
    let status = status_code(&message);
    let tagged = |codes: &[&str]| {
        codes.iter().any(|code| {
            message.contains(&format!("code={code}")) || message.contains(&format!("type={code}"))
        })
    };
    if message.contains("ai_request_cancelled") {
        AiErrorKind::Cancelled
    } else if CREDENTIAL_INVALID_CODES
        .iter()
        .any(|code| message.contains(&format!("code={code}")))
    {
        AiErrorKind::CredentialInvalid
    } else if status == Some(401) || message.contains("unauthorized") {
        AiErrorKind::Auth
    } else if tagged(&POLICY_CODES) {
        // A policy rejection belongs to this request, not to the credential.
        // Trying every key would repeat the same rejected request.
        AiErrorKind::Request
    } else if status == Some(403) || message.contains("forbidden") {
        AiErrorKind::Permission
    } else if status == Some(402) || tagged(&QUOTA_CODES) {
        AiErrorKind::Quota
    } else if status == Some(429) || message.contains("rate limit") {
        AiErrorKind::RateLimit
    } else if QUOTA_PHRASES.iter().any(|phrase| message.contains(phrase)) {
        // Read after the status codes so that a 429 whose prose happens to say
        // "quota" still cools down for a minute rather than an hour. Guessing
        // low costs one wasted attempt; guessing high sidelines a live key.
        AiErrorKind::Quota
    } else if status.is_some_and(|status| (500..600).contains(&status)) {
        AiErrorKind::Provider5xx
    } else if message.contains("ai_stream_incomplete") || message.contains("protocol") {
        AiErrorKind::Protocol
    } else if status.is_some_and(|status| (400..500).contains(&status))
        || message.contains("ai_model_list_invalid")
        || message.contains("ai_model_list_empty")
        || message.contains("ai_model_list_too_large")
    {
        // Every 4xx that identifies a key or an allowance was claimed above, so
        // what is left is the shape of the request. Retrying it under the next
        // key would send the same rejected bytes again.
        AiErrorKind::Request
    } else if message.contains("ai_not_configured")
        || message.contains("ai_no_usable_keys")
        || message.contains("ai_keys_disabled")
        || message.contains("ai_all_keys_invalid")
    {
        AiErrorKind::NotConfigured
    } else {
        AiErrorKind::Network
    }
}

fn is_cancelled(error: &AppError) -> bool {
    error.to_string().contains("AI_REQUEST_CANCELLED")
}

fn sanitized_error_detail(error: &AppError, secret: Option<&str>) -> String {
    let mut detail = error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(secret) = secret.filter(|value| !value.is_empty()) {
        detail = detail.replace(secret, "[redacted]");
    }
    detail.chars().take(300).collect()
}

fn now() -> i64 {
    Utc::now().timestamp_millis()
}

fn cancellation_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Request ids cancelled while no sender was registered. A multi-step job
/// (per-section summary generation) unregisters its id for a brief window
/// between steps — `complete_with_failover` calls `finish_request` when each
/// section completes, and the next section re-registers. A Stop click landing
/// in that gap would otherwise find no sender and be dropped, so the remaining
/// sections keep generating. Recorded here and honored by the next
/// `register_request` / `request_is_cancelled`. Pruned by TTL so a cancel that
/// never gets a matching registration (e.g. a Stop that races completion)
/// can't accumulate. Request ids are UUIDs, so a stale entry can never cancel
/// an unrelated future request.
fn pending_cancellations() -> &'static Mutex<HashMap<String, i64>> {
    static PENDING: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

const PENDING_CANCEL_TTL_MS: i64 = 5 * 60 * 1000;

fn record_pending_cancellation(request_id: &str) {
    if let Ok(mut pending) = pending_cancellations().lock() {
        let now = now();
        pending.retain(|_, recorded| now - *recorded < PENDING_CANCEL_TTL_MS);
        pending.insert(request_id.to_string(), now);
    }
}

fn has_pending_cancellation(request_id: &str) -> bool {
    if let Ok(mut pending) = pending_cancellations().lock() {
        let now = now();
        pending.retain(|_, recorded| now - *recorded < PENDING_CANCEL_TTL_MS);
        return pending.contains_key(request_id);
    }
    false
}

fn take_pending_cancellation(request_id: &str) -> bool {
    if let Ok(mut pending) = pending_cancellations().lock() {
        let now = now();
        pending.retain(|_, recorded| now - *recorded < PENDING_CANCEL_TTL_MS);
        return pending.remove(request_id).is_some();
    }
    false
}

pub fn register_request(request_id: &str) -> watch::Receiver<bool> {
    let (sender, receiver) = watch::channel(false);
    // Honor a cancel that arrived while this id was between registrations.
    //
    // The pending flag is read while the registry lock is held, and
    // `cancel_request` holds the same lock across its whole decision. That
    // closes the window the two used to leave between them, where a cancel
    // could look up this id, find nothing, and record a flag this registration
    // had already walked past — leaving a sender nobody would ever signal and a
    // request that ran to completion with Stop already pressed.
    let registry = cancellation_registry().lock();
    if take_pending_cancellation(request_id) {
        let _ = sender.send(true);
    }
    if let Ok(mut registry) = registry {
        registry.insert(request_id.to_string(), sender);
    }
    receiver
}

pub fn finish_request(request_id: &str) {
    if let Ok(mut registry) = cancellation_registry().lock() {
        registry.remove(request_id);
    }
}

pub fn cancel_request(request_id: &str) -> bool {
    // The lookup and the fallback record stay under one lock — see
    // `register_request` for what splitting them let through.
    match cancellation_registry().lock() {
        Ok(registry) => match registry.get(request_id) {
            Some(sender) => sender.send(true).is_ok(),
            // No live request right now. Remember the cancel so a multi-step
            // job that re-registers this id in its next step (or checks before
            // it registers) still stops instead of running to completion.
            None => {
                record_pending_cancellation(request_id);
                true
            }
        },
        Err(_) => {
            record_pending_cancellation(request_id);
            true
        }
    }
}

pub fn request_is_cancelled(request_id: &str) -> bool {
    let signalled = cancellation_registry()
        .lock()
        .ok()
        .and_then(|registry| registry.get(request_id).cloned())
        .is_some_and(|sender| *sender.borrow());
    signalled || has_pending_cancellation(request_id)
}

fn suffix(value: &str) -> String {
    value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn compensation_failure(
    operation: &str,
    primary: &dyn std::fmt::Display,
    compensation: &dyn std::fmt::Display,
) -> AppError {
    AppError::Other(format!(
        "{operation}: primary=[{primary}]; compensation=[{compensation}]"
    ))
}

pub fn migrate_legacy_config(db: &Db, secrets: &Secrets) -> AppResult<()> {
    let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let profile_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM ai_profiles", [], |row| row.get(0))?;
    if profile_count > 0 {
        return Ok(());
    }

    let get = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    };
    let provider = get("ai_provider").unwrap_or_else(|| "openai".to_string());
    let profile_id = uuid::Uuid::new_v4().to_string();
    let created_at = now();
    let profile_label = get("ai_provider_label")
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| provider.clone());
    let auth_mode = get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string());
    let base_url = get("ai_base_url");
    let model = get("ai_model").unwrap_or_else(|| "gpt-4o-mini".to_string());
    let temperature = get("ai_temperature")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.3);
    let keep_alive = get("ai_keep_alive");
    // Startup migration is metadata-only. Reading an old Keychain item here
    // would show a system password dialog before the user has any context.
    let has_legacy_ai_config = [
        "ai_provider",
        "ai_provider_label",
        "ai_auth_mode",
        "ai_base_url",
        "ai_model",
    ]
    .iter()
    .any(|key| get(key).is_some());
    let legacy_key_exists = secrets.has_stored_secret_metadata("ai_api_key")
        || get("ai_api_key_configured").is_some_and(|value| value == "true")
        // Builds before profile metadata existed stored the one API key only
        // in Keychain. Existing AI settings are a safe, metadata-only signal
        // that the legacy account should be offered for import on first use.
        || (auth_mode == "api_key" && provider != "ollama" && has_legacy_ai_config);
    let credential = legacy_key_exists.then(|| {
        let id = uuid::Uuid::new_v4().to_string();
        (id, "ai_api_key".to_string())
    });

    let result = (|| -> AppResult<()> {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO ai_profiles (id, label, provider, auth_mode, base_url, model, temperature, keep_alive, enabled, priority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, ?9, ?9)",
            params![profile_id, profile_label, provider, auth_mode, base_url, model, temperature, keep_alive, created_at],
        )?;
        if let Some((credential_id, secret_ref)) = credential.as_ref() {
            tx.execute(
                "INSERT INTO ai_credentials (id, profile_id, label, secret_ref, masked_suffix, enabled, priority, state, created_at, updated_at) VALUES (?1, ?2, 'Primary key', ?3, ?4, 1, 0, 'active', ?5, ?5)",
                params![credential_id, profile_id, secret_ref, "", created_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    drop(conn);
    result?;
    Ok(())
}

const PROFILE_COLUMNS: &str =
    "id, label, provider, auth_mode, base_url, model, temperature, keep_alive, enabled, priority, state, cooldown_until, last_error_kind, last_used_at, last_latency_ms, reasoning_effort, reasoning_effort_all_features";

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProfile> {
    Ok(AiProfile {
        view: AiProfileView {
            id: row.get(0)?,
            label: row.get(1)?,
            provider: row.get(2)?,
            auth_mode: row.get(3)?,
            base_url: row.get(4)?,
            model: row.get(5)?,
            temperature: row.get(6)?,
            keep_alive: row.get(7)?,
            enabled: row.get::<_, i64>(8)? != 0,
            priority: row.get(9)?,
            state: row.get(10)?,
            cooldown_until: row.get(11)?,
            last_error_kind: row.get(12)?,
            last_used_at: row.get(13)?,
            last_latency_ms: row.get(14)?,
            reasoning_effort: row.get(15)?,
            reasoning_effort_all_features: row.get::<_, i64>(16)? != 0,
        },
    })
}

/// What the routed request is for. Reasoning effort is a chat-level setting: a
/// vocabulary card or an inline translation should not pay for deep thinking
/// unless the profile explicitly opts every feature in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiRequestPurpose {
    /// Words the reader wrote themselves — the chat sidebar, a custom action
    /// they authored. What the model does with them is their business.
    Chat,
    /// A prompt Lantern wrote and whose shape Lantern dictates: a lookup card,
    /// a sentence explanation, a chat title, a vocabulary pass.
    Utility,
}

/// The level that asks a model not to think. OpenAI-compatible endpoints spell
/// it this way; `anthropic` turns it into a disabled thinking block.
const NO_REASONING: &str = "none";

/// Whether the caller is asking again on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiRetryMode {
    /// Honour cooldowns: a model that just failed is skipped entirely.
    Automatic,
    /// The user asked again. A cooldown is only Lantern's guess about when a
    /// model will work — the provider rarely says — and a deliberate retry
    /// outranks a guess. Invalid credentials stay excluded either way, because
    /// retrying a key that was rejected is not a guess, it is a known answer.
    Manual,
}

/// A retry the user asked for outranks a cooldown Lantern recorded on its own.
/// Absent or `false` means the app started this request, not the reader.
pub fn retry_mode(retry: Option<bool>) -> AiRetryMode {
    if retry.unwrap_or(false) {
        AiRetryMode::Manual
    } else {
        AiRetryMode::Automatic
    }
}

/// The instant a cooldown is measured against. A manual retry compares against
/// the end of time, so every deadline has already passed.
fn cooldown_cutoff(retry: AiRetryMode) -> i64 {
    match retry {
        AiRetryMode::Automatic => now(),
        AiRetryMode::Manual => i64::MAX,
    }
}

/// The reasoning level to ask for, before the endpoint gets a say.
///
/// Sending no field is not the same as asking for no thinking. Left to its own
/// default a reasoning model thinks about a two-word lookup for the better part
/// of a minute, and on an OpenAI-compatible endpoint that thinking is billed and
/// timed like the answer. So a prompt Lantern wrote asks for `none` outright
/// rather than staying quiet and hoping. (Measured on `deepseek-v4-flash`: one
/// lookup card took 43.4s and 16.7k reasoning characters with the field unset,
/// and 8.5s with none of it when the field said `none`.)
///
/// Opting every feature in hands those requests back to the reader's own level,
/// including the case where they set no level at all.
fn effort_for(profile: &AiProfileView, purpose: AiRequestPurpose) -> Option<&str> {
    if purpose == AiRequestPurpose::Chat || profile.reasoning_effort_all_features {
        profile.reasoning_effort.as_deref()
    } else {
        Some(NO_REASONING)
    }
}

/// Whether an effort is the reader's own setting rather than Lantern's `none`.
///
/// What Lantern asked for on its own may be dropped or retried silently. What
/// the reader chose may not: clearing it or announcing it behind their back
/// would be reporting a decision they never made.
fn is_reader_choice(profile: &AiProfile, effort: &str) -> bool {
    profile.view.reasoning_effort.as_deref() == Some(effort)
}

/// Whether Lantern's `none` is worth sending to this endpoint.
///
/// The stored levels exist only because this endpoint once rejected an effort
/// and spelled out what it takes instead. Sending a level it did not name would
/// buy one rejection and one retry on every lookup from then on, so `none` is
/// dropped and the model is left to its own default — slower, but it answers.
fn endpoint_may_accept(db: &Db, profile: &AiProfile, effort: &str) -> bool {
    if is_reader_choice(profile, effort) {
        return true;
    }
    let known = reasoning_effort_options(
        db,
        &profile.view.provider,
        profile.view.base_url.as_deref(),
        &profile.view.model,
    )
    .unwrap_or_default();
    known.options.is_empty() || known.options.iter().any(|option| option == effort)
}

fn normalize_reasoning_effort(value: Option<String>) -> AppResult<Option<String>> {
    let value = value
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(value) = value.as_deref() {
        let shaped = value.chars().count() <= 32
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !shaped {
            return Err(AppError::Other("AI_REASONING_EFFORT_INVALID".to_string()));
        }
    }
    Ok(value)
}

/// The endpoint a hint belongs to. Keyed by model as well as URL because one
/// gateway serves many models and they rarely accept the same effort levels.
///
/// Takes the parts rather than a profile so the settings UI can look hints up
/// for a draft it has not saved yet.
pub fn effort_hint_key(provider: &str, base_url: Option<&str>, model: &str) -> (String, String) {
    let resolved = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| provider_default_base_url(provider).map(str::to_string))
        .unwrap_or_else(|| provider.to_string());
    (
        resolved.trim_end_matches('/').to_string(),
        model.trim().to_string(),
    )
}

/// Values named by a rejection body, e.g.
/// `Supported values are: 'low', 'medium', 'high'`. Returns empty when the
/// provider did not spell them out — learning is opportunistic.
///
/// Shared with the speech settings, which learn the voices an endpoint accepts
/// from the identically worded rejection of a bad `voice`.
pub(crate) fn parse_supported_values(message: &str) -> Vec<String> {
    const MARKERS: [&str; 4] = [
        "supported values are",
        "allowed values are",
        "must be one of",
        "expected one of",
    ];
    const NOISE: [&str; 6] = ["or", "and", "the", "is", "are", "one"];
    let lowered = message.to_ascii_lowercase();
    let Some(start) = MARKERS
        .iter()
        .find_map(|marker| lowered.find(marker).map(|index| index + marker.len()))
    else {
        return Vec::new();
    };
    let tail: String = lowered[start..].chars().take(200).collect();
    let mut options: Vec<String> = Vec::new();
    for token in tail.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        if token.is_empty() || token.len() > 32 || NOISE.contains(&token) {
            continue;
        }
        if !options.iter().any(|existing| existing == token) {
            options.push(token.to_string());
        }
        if options.len() >= 12 {
            break;
        }
    }
    options
}

fn store_effort_hints(db: &Db, base_url: &str, model: &str, options: &[String]) {
    let Ok(payload) = serde_json::to_string(options) else {
        return;
    };
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let _ = conn.execute(
        "INSERT INTO ai_reasoning_effort_hints (base_url, model, options, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(base_url, model) DO UPDATE SET options = ?3, updated_at = ?4",
        params![base_url, model, payload, now()],
    );
}

/// What a rejection taught us about one endpoint, and when. The timestamp is
/// half the answer to "where did these come from?", so it travels with them.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct EffortHints {
    pub options: Vec<String>,
    pub updated_at: Option<i64>,
}

pub fn reasoning_effort_options(
    db: &Db,
    provider: &str,
    base_url: Option<&str>,
    model: &str,
) -> AppResult<EffortHints> {
    let (base_url, model) = effort_hint_key(provider, base_url, model);
    let stored: Option<(String, i64)> = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .query_row(
            "SELECT options, updated_at FROM ai_reasoning_effort_hints WHERE base_url = ?1 AND model = ?2",
            params![base_url, model],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((payload, updated_at)) = stored else {
        return Ok(EffortHints::default());
    };
    Ok(EffortHints {
        options: serde_json::from_str::<Vec<String>>(&payload).unwrap_or_default(),
        updated_at: Some(updated_at),
    })
}

/// Forgets what one endpoint reported. A gateway can start serving a different
/// model behind the same name, which makes the stored levels a lie the user has
/// no other way to correct.
pub fn forget_reasoning_effort_options(
    db: &Db,
    provider: &str,
    base_url: Option<&str>,
    model: &str,
) -> AppResult<()> {
    let (base_url, model) = effort_hint_key(provider, base_url, model);
    db.conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .execute(
            "DELETE FROM ai_reasoning_effort_hints WHERE base_url = ?1 AND model = ?2",
            params![base_url, model],
        )?;
    Ok(())
}

/// A request that ran on a model other than the one at the head of the route.
///
/// Whether the switch is worth telling the user about is a question about
/// money, and money is a property of the catalog, which lives in the frontend.
/// So this reports the plain facts — which model was expected, which one
/// answered, when the expected one comes back — and lets the caller decide.
#[derive(Debug, Clone, serde::Serialize)]
struct AiRouteFallback {
    from_profile_id: String,
    from_label: String,
    from_provider: String,
    from_model: String,
    to_profile_id: String,
    to_label: String,
    to_provider: String,
    to_model: String,
    /// Epoch milliseconds, or `None` when the failure needs the user to act and
    /// so has no deadline at all. Never a guess.
    recovers_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AiReasoningEffortCleared {
    profile_id: String,
    profile_label: String,
    effort: String,
    options: Vec<String>,
}

/// Decide whether a failed attempt should be retried without the reasoning
/// effort, and record what the failure taught us.
///
/// The check is deliberately wide: any request-shaped rejection (400/422) while
/// an effort was set retries once without it. Gateways word this rejection every
/// way imaginable, and the cost of being wrong is one extra failed request,
/// while the cost of being narrow is an answer the user never gets.
fn handle_effort_rejection<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    profile: &AiProfile,
    effort: &str,
    error: &AppError,
    persist_clear: bool,
) -> bool {
    if !matches!(classify_error(error), AiErrorKind::Request) {
        return false;
    }
    let (base_url, model) = effort_hint_key(
        &profile.view.provider,
        profile.view.base_url.as_deref(),
        &profile.view.model,
    );
    let options = parse_supported_values(&error.to_string());
    if !options.is_empty() {
        store_effort_hints(db, &base_url, &model, &options);
    }
    // Lantern's own `none` was never the reader's decision, so an endpoint that
    // refuses it costs them nothing beyond the silent retry below: no setting of
    // theirs is cleared, and there is nothing to tell them about.
    let reader_choice = is_reader_choice(profile, effort);
    if persist_clear && reader_choice {
        if let Ok(conn) = db.conn.lock() {
            let _ = conn.execute(
                "UPDATE ai_profiles SET reasoning_effort = NULL, updated_at = ?1 WHERE id = ?2",
                params![now(), profile.view.id],
            );
        }
    }
    log::warn!(
        "ai router: profile={} rejected reasoning effort '{}', retrying without it",
        profile.view.id,
        effort
    );
    if reader_choice {
        let _ = app.emit(
            "ai-reasoning-effort-cleared",
            AiReasoningEffortCleared {
                profile_id: profile.view.id.clone(),
                profile_label: profile.view.label.clone(),
                effort: effort.to_string(),
                options,
            },
        );
    }
    true
}

/// Switches already announced: the pair of models a request moved between,
/// against the recovery deadline the reader was given for it.
type AnnouncedFallbacks = HashMap<(String, String), Option<i64>>;

/// The one table of those, for the life of the process. See `fallback_is_news`.
fn announced_fallbacks() -> &'static Mutex<AnnouncedFallbacks> {
    static ANNOUNCED: OnceLock<Mutex<AnnouncedFallbacks>> = OnceLock::new();
    ANNOUNCED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether this switch is something the reader has not already been told, and
/// record it if so.
///
/// Routing filters a failed model out for the length of its cooldown, so a
/// second request inside that window normally has no switch left to announce.
/// Two cases slip past that, and both put the same notice on screen again:
///
/// - Requests already in flight when the failure landed. A chat in the sidebar
///   and a chapter summary in the background both start before the cooldown is
///   written, both fail, and both fall to the same model.
/// - A model that fails without earning a cooldown at all. When every key it
///   has is invalid, the profile is not filtered out and contributes nothing,
///   so *every* request from then on falls off it — a notice per request until
///   the reader fixes the key.
///
/// So a pair is news only when the reason changed: the deadline last reported
/// has passed (a genuinely new outage), or there was no deadline before and
/// there is one now. An unchanged nothing stays quiet after the first time.
fn fallback_is_news(from_id: &str, to_id: &str, recovers_at: Option<i64>) -> bool {
    let Ok(mut announced) = announced_fallbacks().lock() else {
        // Never swallow the notice to save a lock.
        return true;
    };
    let key = (from_id.to_string(), to_id.to_string());
    match announced.get(&key) {
        Some(&Some(deadline)) if deadline > now() => false,
        Some(&None) if recovers_at.is_none() => false,
        _ => {
            announced.insert(key, recovers_at);
            true
        }
    }
}

/// Announce a model switch the user did not ask for, once the request has
/// actually landed somewhere else.
///
/// Silent when the request ran on the model at the head of the route, which is
/// the overwhelmingly common case, and silent on a repeat of a switch the
/// reader has already been told about — see `fallback_is_news`.
fn emit_route_fallback<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    expected: Option<&AiProfileView>,
    used: &AiProfileView,
) {
    let Some(expected) = expected else { return };
    if expected.id == used.id {
        return;
    }
    // Read back rather than trusting the copy this request started with: the
    // deadline worth reporting is the one the failure just wrote.
    let recovers_at = profile_by_id(db, &expected.id)
        .ok()
        .and_then(|profile| profile.view.cooldown_until)
        .filter(|deadline| *deadline > now());
    if !fallback_is_news(&expected.id, &used.id, recovers_at) {
        return;
    }
    let _ = app.emit(
        "ai-route-fallback",
        AiRouteFallback {
            from_profile_id: expected.id.clone(),
            from_label: expected.label.clone(),
            from_provider: expected.provider.clone(),
            from_model: expected.model.clone(),
            to_profile_id: used.id.clone(),
            to_label: used.label.clone(),
            to_provider: used.provider.clone(),
            to_model: used.model.clone(),
            recovers_at,
        },
    );
}

fn profile_by_id(db: &Db, id: &str) -> AppResult<AiProfile> {
    let conn = db.reader();
    conn.query_row(
        &format!("SELECT {PROFILE_COLUMNS} FROM ai_profiles WHERE id = ?1"),
        params![id],
        row_to_profile,
    )
    .optional()?
    .ok_or_else(|| AppError::Other("AI_PROFILE_NOT_FOUND".to_string()))
}

fn profiles(db: &Db, enabled_only: bool) -> AppResult<Vec<AiProfile>> {
    let conn = db.reader();
    let where_clause = if enabled_only {
        " WHERE enabled = 1"
    } else {
        ""
    };
    let mut statement = conn.prepare(&format!(
        "SELECT {PROFILE_COLUMNS} FROM ai_profiles{where_clause} ORDER BY priority ASC, created_at ASC"
    ))?;
    let profiles = statement
        .query_map([], row_to_profile)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(profiles)
}

/// Whether the profile carries its own credentials instead of a list of keys:
/// an OpenAI OAuth session, or a local Ollama that asks for nothing. These have
/// no per-key health to record and no key list that can run empty, so the two
/// places that ask "what can this model offer the route?" both start here.
fn authenticates_without_keys(profile: &AiProfileView) -> bool {
    (profile.auth_mode == "oauth" && profile.provider == "openai") || profile.provider == "ollama"
}

/// The models still in play for one request, in route order.
///
/// Two ways to be out of play, and the difference matters. A cooling-down model
/// is resting and will come back by itself. A model with no usable key —
/// every key switched off, rejected, or resting — will not come back until the
/// reader does something, and it is the one that used to cause trouble: it was
/// left at the head of the route, contributed nothing to every request, and so
/// every request looked like a fresh switch away from it. Neither is skipped
/// part-way through the traversal; both are gone before it starts, which is
/// what leaves the reader with one honest head of the route.
fn routable_profiles(db: &Db, enabled: Vec<AiProfile>, cutoff: i64) -> AppResult<Vec<AiProfile>> {
    let mut routable = Vec::new();
    for profile in enabled {
        if profile
            .view
            .cooldown_until
            .is_some_and(|deadline| deadline > cutoff)
        {
            continue;
        }
        if authenticates_without_keys(&profile.view)
            || !credentials_for(db, &profile.view.id, cutoff)?.is_empty()
        {
            routable.push(profile);
        }
    }
    Ok(routable)
}

/// Why a set of keys could not carry a request, in terms the reader can act on.
/// Each answer is a different next move: add one, switch one back on, replace
/// one, or wait.
fn no_usable_key_error(credentials: &[AiCredential]) -> AppError {
    let code = if credentials.is_empty() {
        "AI_NOT_CONFIGURED"
    } else if credentials.iter().all(|item| !item.view.enabled) {
        "AI_KEYS_DISABLED"
    } else if credentials
        .iter()
        .filter(|item| item.view.enabled)
        .all(|item| item.view.state == "invalid")
    {
        "AI_ALL_KEYS_INVALID"
    } else if credentials.iter().any(|item| {
        item.view.enabled
            && item
                .view
                .cooldown_until
                .is_some_and(|deadline| deadline > now())
    }) {
        "AI_KEYS_COOLING_DOWN"
    } else {
        "AI_NO_USABLE_KEYS"
    };
    AppError::Other(code.to_string())
}

/// Why the route came up empty before it started. A model that is only resting
/// says so first — that ends by itself and the reader has nothing to do — and
/// only when nothing is resting is the answer about the keys.
fn empty_route_error(db: &Db, enabled: &[AiProfile], cutoff: i64) -> AppResult<AppError> {
    if enabled.iter().any(|profile| {
        profile
            .view
            .cooldown_until
            .is_some_and(|deadline| deadline > cutoff)
    }) {
        return Ok(AppError::Other("AI_KEYS_COOLING_DOWN".to_string()));
    }
    let mut credentials = Vec::new();
    for profile in enabled {
        credentials.extend(all_credentials_for(db, &profile.view.id)?);
    }
    Ok(no_usable_key_error(&credentials))
}

fn active_profile(db: &Db) -> AppResult<AiProfile> {
    profiles(db, true)?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Other("AI_NOT_CONFIGURED".to_string()))
}

const CREDENTIAL_COLUMNS: &str =
    "id, profile_id, label, secret_ref, masked_suffix, enabled, priority, state, cooldown_until, last_error_kind, last_used_at";

fn row_to_credential(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiCredential> {
    Ok(AiCredential {
        secret_ref: row.get(3)?,
        view: AiCredentialView {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            label: row.get(2)?,
            masked_suffix: row.get(4)?,
            enabled: row.get::<_, i64>(5)? != 0,
            priority: row.get(6)?,
            state: row.get(7)?,
            cooldown_until: row.get(8)?,
            last_error_kind: row.get(9)?,
            last_used_at: row.get(10)?,
        },
    })
}

/// Usable credentials for a profile, in route order. `cutoff` is the instant
/// cooldowns are measured against, so a manual retry can pass one that has
/// already outlasted every deadline.
fn credentials_for(db: &Db, profile_id: &str, cutoff: i64) -> AppResult<Vec<AiCredential>> {
    let conn = db.reader();
    let timestamp = cutoff;
    let mut statement = conn.prepare(&format!(
        "SELECT {CREDENTIAL_COLUMNS} FROM ai_credentials WHERE profile_id = ?1 AND enabled = 1 AND state != 'invalid' AND (cooldown_until IS NULL OR cooldown_until <= ?2) ORDER BY priority ASC, created_at ASC"
    ))?;
    let credentials = statement
        .query_map(params![profile_id, timestamp], row_to_credential)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(credentials)
}

fn all_credentials_for(db: &Db, profile_id: &str) -> AppResult<Vec<AiCredential>> {
    let conn = db.reader();
    let mut statement = conn.prepare(&format!(
        "SELECT {CREDENTIAL_COLUMNS} FROM ai_credentials WHERE profile_id = ?1 ORDER BY priority ASC, created_at ASC"
    ))?;
    let credentials = statement
        .query_map(params![profile_id], row_to_credential)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(credentials)
}

fn credential_by_id(db: &Db, id: &str) -> AppResult<AiCredential> {
    let conn = db.reader();
    conn.query_row(
        &format!("SELECT {CREDENTIAL_COLUMNS} FROM ai_credentials WHERE id = ?1"),
        params![id],
        row_to_credential,
    )
    .optional()?
    .ok_or_else(|| AppError::Other("AI_CREDENTIAL_NOT_FOUND".to_string()))
}

fn retry_after_ms(error: &AppError) -> Option<i64> {
    let marker = "retry-after=";
    let message = error.to_string().to_ascii_lowercase();
    let value = message.split(marker).nth(1)?.split_whitespace().next()?;
    value
        .parse::<i64>()
        .ok()
        .map(|seconds| seconds.clamp(1, 86_400) * 1000)
}

fn update_credential_health(
    db: &Db,
    credential: &AiCredential,
    error: Option<AiErrorKind>,
    retry_after: Option<i64>,
) {
    let timestamp = now();
    let Some((state, cooldown)) = credential_health_state(error, retry_after, timestamp) else {
        return;
    };
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let _ = conn.execute(
        "UPDATE ai_credentials SET state = ?1, cooldown_until = ?2, last_error_kind = ?3, last_used_at = ?4, updated_at = ?4 WHERE id = ?5",
        params![state, cooldown, error.map(AiErrorKind::as_str), timestamp, credential.view.id],
    );
}

fn update_profile_health(
    db: &Db,
    profile: &AiProfile,
    error: Option<AiErrorKind>,
    retry_after: Option<i64>,
    latency_ms: Option<u64>,
) {
    let timestamp = now();
    let Some((state, cooldown)) = profile_health_state(error, retry_after, timestamp) else {
        return;
    };
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    let latency = latency_ms.map(|value| value.min(i64::MAX as u64) as i64);
    let _ = conn.execute(
        "UPDATE ai_profiles SET state = ?1, cooldown_until = ?2, last_error_kind = ?3, last_used_at = ?4, last_latency_ms = COALESCE(?5, last_latency_ms), updated_at = ?4 WHERE id = ?6",
        params![state, cooldown, error.map(AiErrorKind::as_str), timestamp, latency, profile.view.id],
    );
}

/// Whether the traversal may move on to the next credential or model.
///
/// Two independent reasons to stop. One is the failure itself: a malformed
/// request will be malformed for every model, so trying them all just wastes
/// the user's time and money. The other is that the answer has already started
/// arriving — switching now would splice two models' output together, or repeat
/// a sentence the reader has read. A non-empty reasoning delta counts as
/// started, because the reader can see it.
fn may_continue_after(kind: AiErrorKind, emitted: bool) -> bool {
    !emitted && kind.retryable()
}

fn profile_health_state(
    error: Option<AiErrorKind>,
    retry_after: Option<i64>,
    timestamp: i64,
) -> Option<(&'static str, Option<i64>)> {
    let state = match error {
        None => ("active", None),
        Some(AiErrorKind::CredentialInvalid) => ("invalid", None),
        Some(AiErrorKind::Auth | AiErrorKind::Permission) => {
            ("cooldown", Some(timestamp + 5 * 60 * 1000))
        }
        // An hour is a guess about when an allowance resets. When the provider
        // states a time, that is the one thing anyone actually knows.
        Some(AiErrorKind::Quota) => (
            "quota",
            Some(timestamp + retry_after.unwrap_or(60 * 60 * 1000)),
        ),
        Some(AiErrorKind::RateLimit) => (
            "cooldown",
            Some(timestamp + retry_after.unwrap_or(60 * 1000)),
        ),
        Some(AiErrorKind::Network | AiErrorKind::Provider5xx | AiErrorKind::Protocol) => {
            ("cooldown", Some(timestamp + 30 * 1000))
        }
        Some(AiErrorKind::Request) => ("active", None),
        Some(AiErrorKind::NotConfigured) => ("unavailable", None),
        Some(AiErrorKind::Cancelled) => return None,
    };
    Some(state)
}

/// The same verdict for one key, which differs in exactly one arm.
///
/// A profile with nothing configured is unavailable; a key cannot be the reason
/// nothing is configured, so it stays active and the next attempt reaches it.
fn credential_health_state(
    error: Option<AiErrorKind>,
    retry_after: Option<i64>,
    timestamp: i64,
) -> Option<(&'static str, Option<i64>)> {
    match profile_health_state(error, retry_after, timestamp)? {
        ("unavailable", _) => Some(("active", None)),
        state => Some(state),
    }
}

async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    if cancel.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_once<R: Runtime>(
    app: &AppHandle<R>,
    profile: &AiProfile,
    api_key: &str,
    oauth_account_id: Option<&str>,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    effort: Option<&str>,
    emitted: Arc<AtomicBool>,
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<()> {
    if *cancel.borrow() {
        return Err(AppError::Other("AI_REQUEST_CANCELLED".to_string()));
    }
    let max_tokens = answer_token_limit(profile, max_tokens);
    let base_url = resolve_base_url(&profile.view)?;
    let stream: Pin<Box<dyn Future<Output = AppResult<()>> + Send + '_>> =
        match profile.view.provider.as_str() {
            "anthropic" => Box::pin(crate::ai::anthropic::stream_chat(
                app,
                base_url,
                api_key,
                &profile.view.model,
                profile.view.temperature,
                messages,
                false,
                event_name,
                max_tokens,
                effort,
                emitted,
            )),
            _ if profile.view.auth_mode == "oauth" && profile.view.provider == "openai" => {
                Box::pin(crate::ai::openai_responses::stream_chat(
                    app,
                    "https://chatgpt.com/backend-api/codex",
                    api_key,
                    &profile.view.model,
                    messages,
                    oauth_account_id,
                    event_name,
                    effort,
                    emitted,
                ))
            }
            _ => Box::pin(crate::ai::openai_compat::stream_chat(
                app,
                base_url,
                api_key,
                &profile.view.model,
                profile.view.temperature,
                messages,
                (profile.view.provider == "ollama")
                    .then_some(profile.view.keep_alive.as_deref())
                    .flatten(),
                event_name,
                max_tokens,
                effort,
                emitted,
            )),
        };
    tokio::select! {
        result = stream => result,
        _ = wait_cancelled(cancel) => {
            Err(AppError::Other("AI_REQUEST_CANCELLED".to_string()))
        }
    }
}

/// `stream_once`, plus the one-shot retry that drops an unsupported reasoning
/// effort. The retry is only safe before any token reached the frontend, so it
/// is gated on `emitted` exactly like credential failover is.
#[allow(clippy::too_many_arguments)]
async fn stream_once_with_effort_fallback<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    profile: &AiProfile,
    api_key: &str,
    oauth_account_id: Option<&str>,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    effort: Option<&str>,
    persist_clear: bool,
    emitted: Arc<AtomicBool>,
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<()> {
    let effort = effort.filter(|effort| endpoint_may_accept(db, profile, effort));
    let result = stream_once(
        app,
        profile,
        api_key,
        oauth_account_id,
        messages,
        event_name,
        max_tokens,
        effort,
        Arc::clone(&emitted),
        cancel,
    )
    .await;
    let Some(effort) = effort else {
        return result;
    };
    let Err(error) = &result else {
        return result;
    };
    if emitted.load(Ordering::Relaxed)
        || !handle_effort_rejection(app, db, profile, effort, error, persist_clear)
    {
        return result;
    }
    stream_once(
        app,
        profile,
        api_key,
        oauth_account_id,
        messages,
        event_name,
        max_tokens,
        None,
        emitted,
        cancel,
    )
    .await
}

fn resolve_base_url(profile: &AiProfileView) -> AppResult<&str> {
    if let Some(configured) = profile
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(configured);
    }
    match provider_default_base_url(&profile.provider) {
        Some(base_url) => Ok(base_url),
        None if profile.provider == "custom" => {
            Err(AppError::Other("AI_CUSTOM_BASE_URL_REQUIRED".to_string()))
        }
        None => Err(AppError::Other("AI_PROVIDER_UNSUPPORTED".to_string())),
    }
}

fn provider_default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com"),
        "anthropic" => Some("https://api.anthropic.com"),
        "ollama" => Some("http://localhost:11434"),
        // DeepSeek speaks the OpenAI chat shape, so only the base URL and the
        // default model differ from `custom`. It exists as its own provider so
        // the preset keeps a stable identity after the user renames the
        // profile, which a label-only match would lose.
        "deepseek" => Some(DEEPSEEK_BASE_URL),
        _ => None,
    }
}

/// Published without a version segment, so `compat_endpoint` appends `/v1`.
pub(crate) const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";

fn models_endpoint(profile: &AiProfileView) -> AppResult<String> {
    let base = resolve_base_url(profile)?.trim_end_matches('/');
    match profile.provider.as_str() {
        "ollama" => Ok(if base.ends_with("/api") {
            format!("{base}/tags")
        } else {
            format!("{base}/api/tags")
        }),
        "openai" | "anthropic" | "custom" | "deepseek" => {
            Ok(crate::ai::compat_endpoint(base, "models"))
        }
        _ => Err(AppError::Other("AI_PROVIDER_UNSUPPORTED".to_string())),
    }
}

async fn read_json_limited(response: reqwest::Response) -> AppResult<serde_json::Value> {
    const MAX_BYTES: usize = 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err(AppError::Other("AI_MODEL_LIST_TOO_LARGE".to_string()));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    // Bound each read so a stalled endpoint can't hang "list models" (and the
    // settings UI spinner) indefinitely — the first-byte timeout only covers
    // the initial response, not a body that trickles or stops mid-stream.
    while let Some(chunk) = tokio::time::timeout(crate::ai::STREAM_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| AppError::Other("AI_MODEL_LIST_TIMEOUT".to_string()))?
    {
        let chunk = chunk.map_err(|error| AppError::Ai(error.to_string()))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(AppError::Other("AI_MODEL_LIST_TOO_LARGE".to_string()));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| AppError::Other("AI_MODEL_LIST_INVALID".to_string()))
}

fn parse_model_ids(provider: &str, value: &serde_json::Value) -> AppResult<Vec<String>> {
    let values = if provider == "ollama" {
        value.get("models").and_then(serde_json::Value::as_array)
    } else {
        value.get("data").and_then(serde_json::Value::as_array)
    }
    .ok_or_else(|| AppError::Other("AI_MODEL_LIST_INVALID".to_string()))?;

    let mut models = BTreeSet::new();
    for item in values.iter().take(2_000) {
        let id = if provider == "ollama" {
            item.get("model")
                .or_else(|| item.get("name"))
                .and_then(serde_json::Value::as_str)
        } else {
            item.get("id").and_then(serde_json::Value::as_str)
        };
        if let Some(id) = id
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        {
            models.insert(id.to_string());
        }
    }
    if models.is_empty() {
        return Err(AppError::Other("AI_MODEL_LIST_EMPTY".to_string()));
    }
    Ok(models.into_iter().collect())
}

/// Model discovery for an OpenAI-shaped endpoint that is not an AI profile —
/// today the custom TTS service. Shares the profile path's byte cap, timeouts
/// and response parsing rather than growing a second implementation.
pub async fn list_openai_models(base_url: &str, api_key: &str) -> AppResult<Vec<String>> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Other("AI_CUSTOM_BASE_URL_REQUIRED".to_string()));
    }
    let endpoint = crate::ai::compat_endpoint(base, "models");
    let mut request = crate::ai::http_client().get(&endpoint);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.send())
        .await
        .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
        .map_err(|error| AppError::Ai(error.to_string()))?;
    if !response.status().is_success() {
        return Err(crate::ai::http_status_error("model-list", response).await);
    }
    let value = read_json_limited(response).await?;
    parse_model_ids("openai", &value)
}

async fn list_models_once(
    profile: &AiProfile,
    endpoint: &str,
    api_key: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut request = crate::ai::http_client().get(endpoint);
    if let Some(key) = api_key {
        request = if profile.view.provider == "anthropic" {
            request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(key)
        };
    }
    let response = tokio::time::timeout(crate::ai::FIRST_BYTE_TIMEOUT, request.send())
        .await
        .map_err(|_| AppError::Ai("AI_FIRST_BYTE_TIMEOUT".to_string()))?
        .map_err(|error| AppError::Ai(error.to_string()))?;
    if !response.status().is_success() {
        return Err(crate::ai::http_status_error("model-list", response).await);
    }
    let value = read_json_limited(response).await?;
    parse_model_ids(&profile.view.provider, &value)
}

pub async fn list_models(
    db: &Db,
    secrets: &Secrets,
    profile_id: &str,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
) -> AppResult<Vec<String>> {
    let mut profile = profile_by_id(db, profile_id)?;
    let (_, provider, auth_mode, base_url, _, _, _) = normalize_profile_config(
        profile.view.label.clone(),
        provider,
        auth_mode,
        base_url,
        profile.view.model.clone(),
        profile.view.temperature,
        profile.view.keep_alive.clone(),
    )?;
    profile.view.provider = provider;
    profile.view.auth_mode = auth_mode;
    profile.view.base_url = base_url;

    if profile.view.auth_mode == "oauth" {
        return Err(AppError::Other("AI_MODEL_LIST_UNSUPPORTED".to_string()));
    }

    // Model discovery is an explicit settings action. Use enabled credentials
    // even when inference health put them in cooldown, but do not mutate that
    // health here: a provider may deny or omit `/models` while inference still
    // works, and this request may be probing an unsaved URL/provider draft.
    let endpoint = models_endpoint(&profile.view)?;
    if profile.view.provider == "ollama" {
        return list_models_once(&profile, &endpoint, None).await;
    }

    let candidates: Vec<_> = all_credentials_for(db, profile_id)?
        .into_iter()
        .filter(|credential| credential.view.enabled)
        .collect();
    if candidates.is_empty() {
        return Err(AppError::Other("AI_NO_USABLE_KEYS".to_string()));
    }

    let mut last_error = None;
    for credential in candidates {
        let Some(key) = secrets
            .get(&credential.secret_ref)?
            .filter(|value| !value.trim().is_empty())
        else {
            last_error = Some(AppError::Other("AI_CREDENTIAL_UNAVAILABLE".to_string()));
            continue;
        };

        match list_models_once(&profile, &endpoint, Some(&key)).await {
            Ok(models) => return Ok(models),
            Err(error) => {
                let kind = classify_error(&error);
                if !kind.retryable() {
                    return Err(error);
                }
                log::warn!(
                    "ai router: profile={} credential={} model discovery failed kind={}, trying next candidate",
                    profile.view.id,
                    credential.view.id,
                    kind.as_str()
                );
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::Other("AI_NO_USABLE_KEYS".to_string())))
}

#[allow(clippy::too_many_arguments)]
pub async fn stream_with_failover<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    purpose: AiRequestPurpose,
    retry: AiRetryMode,
    request_id: Option<&str>,
) -> AppResult<()> {
    let mut cancel = request_id
        .and_then(|id| {
            cancellation_registry()
                .lock()
                .ok()
                .and_then(|registry| registry.get(id).map(watch::Sender::subscribe))
        })
        .unwrap_or_else(|| {
            request_id
                .map(register_request)
                .unwrap_or_else(|| watch::channel(false).1)
        });
    let result = stream_with_failover_inner(
        app,
        db,
        secrets,
        messages,
        event_name,
        max_tokens,
        purpose,
        retry,
        &mut cancel,
    )
    .await;
    if let Some(id) = request_id {
        finish_request(id);
    }
    result.map(|_| ())
}

/// Run the same routed stream without exposing its token event name to the
/// frontend. Existing provider adapters emit through `AppHandle`, so a private
/// per-request listener collects those deltas until the adapters can be moved
/// to a provider-neutral sink.
#[allow(clippy::too_many_arguments)]
pub async fn complete_with_failover<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    messages: &[ChatMessage],
    max_tokens: Option<u32>,
    purpose: AiRequestPurpose,
    retry: AiRetryMode,
    request_id: Option<&str>,
    forward_event_name: Option<&str>,
) -> AppResult<AiCompletion> {
    let event_name = format!("ai-internal-completion-{}", uuid::Uuid::new_v4());
    let output = Arc::new(Mutex::new(String::new()));
    let first_token_ms = Arc::new(Mutex::new(None));
    let started = Instant::now();
    let listener_output = Arc::clone(&output);
    let listener_first_token = Arc::clone(&first_token_ms);
    let forward_event_name = forward_event_name.map(str::to_string);
    let forward_app = app.clone();
    let listener_id = app.listen(event_name.clone(), move |event| {
        let Ok(chunk) = serde_json::from_str::<crate::commands::ai::AiStreamChunk>(event.payload())
        else {
            return;
        };
        if let Some(event_name) = forward_event_name.as_deref() {
            let _ = forward_app.emit(event_name, &chunk);
        }
        if chunk.done || chunk.delta.is_empty() {
            return;
        }
        if let Ok(mut first) = listener_first_token.lock() {
            first.get_or_insert_with(|| started.elapsed().as_millis() as u64);
        }
        if let Ok(mut text) = listener_output.lock() {
            text.push_str(&chunk.delta);
        }
    });

    let mut cancel = request_id
        .and_then(|id| {
            cancellation_registry()
                .lock()
                .ok()
                .and_then(|registry| registry.get(id).map(watch::Sender::subscribe))
        })
        .unwrap_or_else(|| {
            request_id
                .map(register_request)
                .unwrap_or_else(|| watch::channel(false).1)
        });
    let routed = stream_with_failover_inner(
        app,
        db,
        secrets,
        messages,
        &event_name,
        max_tokens,
        purpose,
        retry,
        &mut cancel,
    )
    .await;
    app.unlisten(listener_id);
    if let Some(id) = request_id {
        finish_request(id);
    }

    let profile = routed?;
    let total_ms = started.elapsed().as_millis() as u64;
    let text = output
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .clone();
    let first_token_ms = *first_token_ms
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(AiCompletion {
        text,
        profile_id: profile.id,
        provider: profile.provider,
        model: profile.model,
        first_token_ms,
        total_ms,
    })
}

#[allow(clippy::too_many_arguments)]
async fn stream_with_profile_inner<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    profile_id: &str,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<AiProfileView> {
    let profile = profile_by_id(db, profile_id)?;
    if !profile.view.enabled {
        return Err(AppError::Other("AI_PROFILE_DISABLED".to_string()));
    }
    // This path is background work against a model the user pinned by hand
    // (currently only book summaries), so the effort only rides along when the
    // profile opted every feature in.
    let effort = effort_for(&profile.view, AiRequestPurpose::Utility);
    if profile.view.auth_mode == "oauth" && profile.view.provider == "openai" {
        let (token, account_id) = crate::ai::oauth::get_valid_token(secrets).await?;
        let started = Instant::now();
        let result = stream_once_with_effort_fallback(
            app,
            db,
            &profile,
            &token,
            account_id.as_deref(),
            messages,
            event_name,
            max_tokens,
            effort,
            true,
            Arc::new(AtomicBool::new(false)),
            cancel,
        )
        .await;
        record_profile_attempt(db, &profile, &result, started.elapsed().as_millis() as u64);
        result?;
        return Ok(profile.view);
    }
    if profile.view.provider == "ollama" {
        let started = Instant::now();
        let result = stream_once_with_effort_fallback(
            app,
            db,
            &profile,
            "",
            None,
            messages,
            event_name,
            max_tokens,
            effort,
            true,
            Arc::new(AtomicBool::new(false)),
            cancel,
        )
        .await;
        record_profile_attempt(db, &profile, &result, started.elapsed().as_millis() as u64);
        result?;
        return Ok(profile.view);
    }
    let mut last_error = None;
    let profile_started = Instant::now();
    let mut profile_failure = None;
    for credential in credentials_for(db, profile_id, now())? {
        let Some(key) = secrets
            .get(&credential.secret_ref)?
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let emitted = Arc::new(AtomicBool::new(false));
        match stream_once_with_effort_fallback(
            app,
            db,
            &profile,
            &key,
            None,
            messages,
            event_name,
            max_tokens,
            effort,
            true,
            Arc::clone(&emitted),
            cancel,
        )
        .await
        {
            Ok(()) => {
                update_credential_health(db, &credential, None, None);
                update_profile_health(
                    db,
                    &profile,
                    None,
                    None,
                    Some(profile_started.elapsed().as_millis() as u64),
                );
                return Ok(profile.view);
            }
            Err(error) if is_cancelled(&error) => return Err(error),
            Err(error) => {
                let kind = classify_error(&error);
                let retry_after = retry_after_ms(&error);
                update_credential_health(db, &credential, Some(kind), retry_after);
                profile_failure = Some((kind, retry_after));
                // The same two stopping conditions the routed path applies. The
                // second one matters more here than there: `complete_with_profile`
                // accumulates every delta into one buffer for the whole call, so a
                // key swapped in after output has already landed appends a second
                // copy of the answer to the first one's half.
                if !may_continue_after(kind, emitted.load(Ordering::Relaxed)) {
                    update_profile_health(
                        db,
                        &profile,
                        Some(kind),
                        retry_after,
                        Some(profile_started.elapsed().as_millis() as u64),
                    );
                    return Err(error);
                }
                log::warn!(
                    "ai router: profile={} credential={} failed kind={}, trying next candidate",
                    profile.view.id,
                    credential.view.id,
                    kind.as_str()
                );
                last_error = Some(error);
            }
        }
    }
    if let Some((kind, retry_after)) = profile_failure {
        update_profile_health(
            db,
            &profile,
            Some(kind),
            retry_after,
            Some(profile_started.elapsed().as_millis() as u64),
        );
    }
    Err(last_error.unwrap_or_else(|| AppError::Other("AI_NO_USABLE_KEYS".to_string())))
}

/// Record one whole-profile attempt on a path that has no credential layer to
/// fail over through (OAuth, Ollama).
///
/// This is inference against a saved profile, so its failures belong in the
/// profile's health exactly as the routed path records them. `list_models`
/// deliberately does not record health, but that probes an endpoint a provider
/// may deny while inference still works — this is the inference.
fn record_profile_attempt(db: &Db, profile: &AiProfile, result: &AppResult<()>, latency_ms: u64) {
    let error = result.as_ref().err();
    update_profile_health(
        db,
        profile,
        error.map(classify_error),
        error.and_then(retry_after_ms),
        Some(latency_ms),
    );
}

pub async fn complete_with_profile<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    profile_id: &str,
    messages: &[ChatMessage],
    max_tokens: Option<u32>,
    request_id: Option<&str>,
) -> AppResult<AiCompletion> {
    let event_name = format!("ai-internal-profile-completion-{}", uuid::Uuid::new_v4());
    let output = Arc::new(Mutex::new(String::new()));
    let listener_output = Arc::clone(&output);
    let listener_id = app.listen(event_name.clone(), move |event| {
        let Ok(chunk) = serde_json::from_str::<crate::commands::ai::AiStreamChunk>(event.payload())
        else {
            return;
        };
        if !chunk.done && !chunk.delta.is_empty() {
            if let Ok(mut text) = listener_output.lock() {
                text.push_str(&chunk.delta);
            }
        }
    });
    let started = Instant::now();
    let mut cancel = request_id
        .and_then(|id| {
            cancellation_registry()
                .lock()
                .ok()
                .and_then(|registry| registry.get(id).map(watch::Sender::subscribe))
        })
        .unwrap_or_else(|| {
            request_id
                .map(register_request)
                .unwrap_or_else(|| watch::channel(false).1)
        });
    let routed = stream_with_profile_inner(
        app,
        db,
        secrets,
        profile_id,
        messages,
        &event_name,
        max_tokens,
        &mut cancel,
    )
    .await;
    app.unlisten(listener_id);
    if let Some(id) = request_id {
        finish_request(id);
    }
    let profile = routed?;
    let text = output
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .clone();
    Ok(AiCompletion {
        text,
        profile_id: profile.id,
        provider: profile.provider,
        model: profile.model,
        first_token_ms: None,
        total_ms: started.elapsed().as_millis() as u64,
    })
}

/// The token cap that may actually be sent to a provider.
///
/// A cap bounds the answer only on Anthropic, which requires the field. On an
/// OpenAI-compatible endpoint it bounds the reasoning too, so a reasoning model
/// spends the whole budget thinking and returns `finish_reason: length` with an
/// empty answer — the caller gets nothing at all rather than the short answer
/// the cap asked for. (Measured against `deepseek-v4-flash`: a 1536-token cap
/// produced 0 content characters and ~6.7k reasoning characters; unset, the same
/// request answered in full.) Some gateways reject the field outright. Brevity
/// there has to come from the prompt, which is what grounded chat, sentence
/// explanation and the connection probe already rely on.
fn answer_token_limit(profile: &AiProfile, requested: Option<u32>) -> Option<u32> {
    (profile.view.provider == "anthropic")
        .then_some(requested)
        .flatten()
}

fn connection_test_token_limit(profile: &AiProfile) -> Option<u32> {
    // Anthropic requires a limit and accepts this small value; everywhere else
    // the probe sends no cap, for the reason above.
    answer_token_limit(profile, Some(64))
}

/// One thing the route can try against a profile.
///
/// The distinction is not the provider but whether there is a credential row
/// behind the secret: an OAuth token and Ollama's empty key belong to the
/// profile as a whole, so a failure has nowhere per-key to be recorded, while
/// an API key has its own health and its own place in the order.
enum Attempt {
    Direct {
        key: String,
        account_id: Option<String>,
    },
    Credential(AiCredential),
}

#[allow(clippy::too_many_arguments)]
async fn stream_with_failover_inner<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    purpose: AiRequestPurpose,
    retry: AiRetryMode,
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<AiProfileView> {
    let enabled_profiles = profiles(db, true)?;
    if enabled_profiles.is_empty() {
        return Err(AppError::Other("AI_NOT_CONFIGURED".to_string()));
    }
    let timestamp = cooldown_cutoff(retry);
    let profiles = routable_profiles(db, enabled_profiles.clone(), timestamp)?;
    if profiles.is_empty() {
        return Err(empty_route_error(db, &enabled_profiles, timestamp)?);
    }

    let mut last_error = None;
    let mut configured_credentials = Vec::new();
    // The model the user expected to answer: whatever the route puts first
    // among the models still in play. Anything else that answers is a switch.
    let expected = profiles.first().map(|profile| profile.view.clone());

    for profile in profiles {
        // What this profile offers the route to try, in order. A profile that
        // authenticates as a whole offers exactly one thing and has no per-key
        // health to record; an API-key profile offers each usable key, and its
        // secret is fetched only when the route actually reaches it — reading
        // the keychain for a key the first one made unnecessary is not free.
        let attempts = if authenticates_without_keys(&profile.view) {
            if profile.view.provider == "ollama" {
                vec![Attempt::Direct {
                    key: String::new(),
                    account_id: None,
                }]
            } else {
                match crate::ai::oauth::get_valid_token(secrets).await {
                    Ok((token, account_id)) => vec![Attempt::Direct {
                        key: token,
                        account_id,
                    }],
                    Err(error) => {
                        let kind = classify_error(&error);
                        update_profile_health(
                            db,
                            &profile,
                            Some(kind),
                            retry_after_ms(&error),
                            None,
                        );
                        if is_cancelled(&error) || !kind.retryable() {
                            return Err(error);
                        }
                        log::warn!(
                            "ai router: profile={} oauth unavailable, trying next profile",
                            profile.view.id
                        );
                        last_error = Some(error);
                        continue;
                    }
                }
            }
        } else {
            configured_credentials.extend(all_credentials_for(db, &profile.view.id)?);
            credentials_for(db, &profile.view.id, timestamp)?
                .into_iter()
                .map(Attempt::Credential)
                .collect()
        };

        let profile_started = Instant::now();
        let mut profile_failure = None;
        for attempt in attempts {
            let (key, account_id, credential) = match attempt {
                Attempt::Direct { key, account_id } => (key, account_id, None),
                Attempt::Credential(credential) => {
                    let Some(key) = secrets
                        .get(&credential.secret_ref)?
                        .filter(|value| !value.trim().is_empty())
                    else {
                        // The row says there is a key and the keychain says
                        // otherwise. Nothing to send, so nothing to time.
                        update_credential_health(
                            db,
                            &credential,
                            Some(AiErrorKind::CredentialInvalid),
                            None,
                        );
                        profile_failure = Some((AiErrorKind::CredentialInvalid, None));
                        last_error = Some(AppError::Other("AI_CREDENTIAL_UNAVAILABLE".to_string()));
                        continue;
                    };
                    (key, None, Some(credential))
                }
            };
            let emitted = Arc::new(AtomicBool::new(false));
            let result = stream_once_with_effort_fallback(
                app,
                db,
                &profile,
                &key,
                account_id.as_deref(),
                messages,
                event_name,
                max_tokens,
                effort_for(&profile.view, purpose),
                true,
                Arc::clone(&emitted),
                cancel,
            )
            .await;
            // Measured from the profile's first attempt, not this one: the
            // settings page shows one latency per model, and what the reader
            // waited for is the whole time the profile held the request.
            let latency = profile_started.elapsed().as_millis() as u64;
            match result {
                Ok(()) => {
                    if let Some(credential) = &credential {
                        update_credential_health(db, credential, None, None);
                    }
                    update_profile_health(db, &profile, None, None, Some(latency));
                    emit_route_fallback(app, db, expected.as_ref(), &profile.view);
                    return Ok(profile.view.clone());
                }
                Err(error) => {
                    if is_cancelled(&error) {
                        return Err(error);
                    }
                    let kind = classify_error(&error);
                    let retry_after = retry_after_ms(&error);
                    if let Some(credential) = &credential {
                        update_credential_health(db, credential, Some(kind), retry_after);
                    }
                    profile_failure = Some((kind, retry_after));
                    if !may_continue_after(kind, emitted.load(Ordering::Relaxed)) {
                        update_profile_health(db, &profile, Some(kind), retry_after, Some(latency));
                        return Err(error);
                    }
                    log::warn!(
                        "ai router: profile={} credential={} failed kind={}, trying next candidate",
                        profile.view.id,
                        credential
                            .as_ref()
                            .map_or("-", |credential| credential.view.id.as_str()),
                        kind.as_str()
                    );
                    last_error = Some(error);
                }
            }
        }
        if let Some((kind, retry_after)) = profile_failure {
            update_profile_health(
                db,
                &profile,
                Some(kind),
                retry_after,
                Some(profile_started.elapsed().as_millis() as u64),
            );
        }
    }

    if let Some(error) = last_error {
        return Err(error);
    }

    // Reaching here means every model in the route offered a key and none of
    // them raised an error worth keeping — which the filtering above makes hard
    // to arrange. Answer from the keys anyway rather than inventing a reason.
    Err(no_usable_key_error(&configured_credentials))
}

pub fn list_credentials(db: &Db, profile_id: Option<&str>) -> AppResult<Vec<AiCredentialView>> {
    let profile_id = match profile_id {
        Some(id) => profile_by_id(db, id)?.view.id,
        None => active_profile(db)?.view.id,
    };
    all_credentials_for(db, &profile_id)
        .map(|items| items.into_iter().map(|item| item.view).collect())
}

pub fn active_profile_view(db: &Db) -> AppResult<AiProfileView> {
    Ok(active_profile(db)?.view)
}

/// Return the active API-key profile as an OpenAI-compatible embedding source.
/// Anthropic and OAuth/CLI routes do not provide a compatible embeddings API.
pub(crate) fn embedding_source(
    db: &Db,
    secrets: &Secrets,
) -> AppResult<Option<crate::ai::grounding::vector::EmbeddingSource>> {
    let explicit = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok()
        };
        (get("ai_embedding_configured") == Some("true".to_string())).then(|| {
            (
                get("ai_embedding_endpoint"),
                get("ai_embedding_model"),
                get("ai_embedding_dimensions").and_then(|value| value.parse::<usize>().ok()),
            )
        })
    };
    if let Some((Some(endpoint), Some(model), Some(dimensions))) = explicit {
        return Ok(Some(crate::ai::grounding::vector::EmbeddingSource {
            profile_id: "explicit".to_string(),
            endpoint,
            model,
            api_key: secrets.get(crate::ai::grounding::vector::EMBEDDING_SECRET_REF)?,
            dimensions,
        }));
    }
    let profile = match active_profile(db) {
        Ok(profile) => profile,
        Err(AppError::Other(code)) if code == "AI_NOT_CONFIGURED" => return Ok(None),
        Err(error) => return Err(error),
    };
    if profile.view.auth_mode != "api_key"
        || !matches!(profile.view.provider.as_str(), "openai" | "custom")
    {
        return Ok(None);
    }
    let Some(credential) = credentials_for(db, &profile.view.id, now())?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let Some(api_key) = secrets.get(&credential.secret_ref)? else {
        return Ok(None);
    };
    if api_key.trim().is_empty() {
        return Ok(None);
    }
    let endpoint = crate::ai::compat_endpoint(resolve_base_url(&profile.view)?, "embeddings");
    Ok(Some(crate::ai::grounding::vector::EmbeddingSource {
        profile_id: profile.view.id.clone(),
        endpoint,
        model: crate::ai::grounding::vector::DEFAULT_EMBEDDING_MODEL.to_string(),
        api_key: Some(api_key),
        dimensions: crate::ai::grounding::vector::DEFAULT_EMBEDDING_DIMENSIONS,
    }))
}

pub fn migrate_embedding_source(db: &Db, secrets: &Secrets) -> AppResult<()> {
    let should_migrate = {
        let conn = db.reader();
        let vector_enabled = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_vector_retrieval'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .is_some_and(|value| value == "true");
        let explicit = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_embedding_configured'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .is_some_and(|value| value == "true");
        vector_enabled && !explicit
    };
    if !should_migrate {
        return Ok(());
    }
    let Some(source) = embedding_source(db, secrets)? else {
        return Ok(());
    };
    if let Some(credential) = credentials_for(db, &source.profile_id, now())?
        .into_iter()
        .next()
    {
        let _ = secrets.copy_local(
            &credential.secret_ref,
            crate::ai::grounding::vector::EMBEDDING_SECRET_REF,
        )?;
    }
    let conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let dimensions = source.dimensions.to_string();
    for (key, value) in [
        ("ai_embedding_endpoint", source.endpoint.as_str()),
        ("ai_embedding_model", source.model.as_str()),
        ("ai_embedding_dimensions", dimensions.as_str()),
        ("ai_embedding_configured", "true"),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

pub fn list_profiles(db: &Db) -> AppResult<Vec<AiProfileView>> {
    profiles(db, false).map(|items| items.into_iter().map(|item| item.view).collect())
}

fn normalize_profile_config(
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    keep_alive: Option<String>,
) -> AppResult<NormalizedProfileConfig> {
    let label = label.trim().to_string();
    let provider = provider.trim().to_ascii_lowercase();
    let auth_mode = auth_mode.trim().to_ascii_lowercase();
    let model = model.trim().to_string();
    let base_url = base_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let keep_alive = keep_alive
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if label.is_empty() || label.chars().count() > 100 {
        return Err(AppError::Other("AI_PROFILE_LABEL_INVALID".to_string()));
    }
    if !matches!(
        provider.as_str(),
        "openai" | "anthropic" | "ollama" | "custom" | "deepseek"
    ) {
        return Err(AppError::Other("AI_PROVIDER_UNSUPPORTED".to_string()));
    }
    if !matches!(auth_mode.as_str(), "api_key" | "oauth")
        || (auth_mode == "oauth" && provider != "openai")
    {
        return Err(AppError::Other("AI_AUTH_MODE_INVALID".to_string()));
    }
    if model.is_empty() || model.chars().count() > 200 {
        return Err(AppError::Other("AI_MODEL_INVALID".to_string()));
    }
    if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
        return Err(AppError::Other("AI_TEMPERATURE_INVALID".to_string()));
    }
    if provider == "custom" && base_url.is_none() {
        return Err(AppError::Other("AI_CUSTOM_BASE_URL_REQUIRED".to_string()));
    }
    if let Some(url) = base_url.as_deref() {
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| AppError::Other("AI_BASE_URL_INVALID".to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(AppError::Other("AI_BASE_URL_INVALID".to_string()));
        }
    }

    Ok((
        label,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        keep_alive,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn create_profile(
    db: &Db,
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    reasoning_effort_all_features: bool,
    keep_alive: Option<String>,
    enabled: bool,
) -> AppResult<AiProfileView> {
    let (label, provider, auth_mode, base_url, model, temperature, keep_alive) =
        normalize_profile_config(
            label,
            provider,
            auth_mode,
            base_url,
            model,
            temperature,
            keep_alive,
        )?;
    let reasoning_effort = normalize_reasoning_effort(reasoning_effort)?;
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let mut conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let tx = conn.transaction()?;
    let priority: i64 = tx.query_row(
        "SELECT COALESCE(MAX(priority) + 1, 0) FROM ai_profiles",
        [],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO ai_profiles (id, label, provider, auth_mode, base_url, model, temperature, reasoning_effort, reasoning_effort_all_features, keep_alive, enabled, priority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![id, label, provider, auth_mode, base_url, model, temperature, reasoning_effort, reasoning_effort_all_features as i64, keep_alive, enabled as i64, priority, timestamp],
    )?;
    tx.commit()?;
    drop(conn);
    Ok(profile_by_id(db, &id)?.view)
}

pub fn duplicate_profile(db: &Db, id: &str, label: Option<String>) -> AppResult<AiProfileView> {
    let source = profile_by_id(db, id)?.view;
    create_profile(
        db,
        label.unwrap_or_else(|| format!("{} copy", source.label)),
        source.provider,
        source.auth_mode,
        source.base_url,
        source.model,
        source.temperature,
        source.reasoning_effort,
        source.reasoning_effort_all_features,
        source.keep_alive,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn save_profile(
    db: &Db,
    id: String,
    label: String,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    reasoning_effort_all_features: bool,
    keep_alive: Option<String>,
) -> AppResult<AiProfileView> {
    let existing = profile_by_id(db, &id)?.view;
    let (label, provider, auth_mode, base_url, model, temperature, keep_alive) =
        normalize_profile_config(
            label,
            provider,
            auth_mode,
            base_url,
            model,
            temperature,
            keep_alive,
        )?;
    let reasoning_effort = normalize_reasoning_effort(reasoning_effort)?;
    let credential_health_stale = existing.provider != provider
        || existing.auth_mode != auth_mode
        || existing.base_url != base_url;
    let profile_health_stale = credential_health_stale
        || existing.model != model
        || existing.temperature != temperature
        || existing.reasoning_effort != reasoning_effort
        || existing.keep_alive != keep_alive;
    let timestamp = now();
    let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE ai_profiles SET label = ?1, provider = ?2, auth_mode = ?3, base_url = ?4, model = ?5, temperature = ?6, keep_alive = ?7, reasoning_effort = ?11, reasoning_effort_all_features = ?12, state = CASE WHEN ?8 = 1 THEN 'active' ELSE state END, cooldown_until = CASE WHEN ?8 = 1 THEN NULL ELSE cooldown_until END, last_error_kind = CASE WHEN ?8 = 1 THEN NULL ELSE last_error_kind END, last_used_at = CASE WHEN ?8 = 1 THEN NULL ELSE last_used_at END, last_latency_ms = CASE WHEN ?8 = 1 THEN NULL ELSE last_latency_ms END, updated_at = ?9 WHERE id = ?10",
        params![label, provider, auth_mode, base_url, model, temperature, keep_alive, profile_health_stale as i64, timestamp, id, reasoning_effort, reasoning_effort_all_features as i64],
    )?;
    if changed != 1 {
        return Err(AppError::Other("AI_PROFILE_NOT_FOUND".to_string()));
    }
    if credential_health_stale {
        tx.execute(
            "UPDATE ai_credentials SET state = 'active', cooldown_until = NULL, last_error_kind = NULL, last_used_at = NULL, updated_at = ?1 WHERE profile_id = ?2",
            params![timestamp, id],
        )?;
    }
    tx.commit()?;
    drop(conn);
    Ok(profile_by_id(db, &id)?.view)
}

pub fn set_profile_enabled(db: &Db, id: &str, enabled: bool) -> AppResult<()> {
    let changed = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?
        .execute(
            "UPDATE ai_profiles SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled as i64, now(), id],
        )?;
    if changed != 1 {
        return Err(AppError::Other("AI_PROFILE_NOT_FOUND".to_string()));
    }
    Ok(())
}

pub fn reorder_profiles(db: &Db, ids: &[String]) -> AppResult<()> {
    let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() {
        return Err(AppError::Other("AI_PROFILE_ORDER_INVALID".to_string()));
    }
    let existing = list_profiles(db)?;
    let existing_ids: HashSet<&str> = existing.iter().map(|profile| profile.id.as_str()).collect();
    if unique != existing_ids {
        return Err(AppError::Other("AI_PROFILE_ORDER_INCOMPLETE".to_string()));
    }

    let timestamp = now();
    let mut conn = db
        .conn
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let tx = conn.transaction()?;
    for (priority, id) in ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE ai_profiles SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority as i64, timestamp, id],
        )?;
        if changed != 1 {
            return Err(AppError::Other("AI_PROFILE_NOT_FOUND".to_string()));
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_profile(db: &Db, secrets: &Secrets, id: &str) -> AppResult<()> {
    profile_by_id(db, id)?;
    let credentials = all_credentials_for(db, id)?;
    let snapshots = credentials
        .iter()
        .map(|credential| {
            secrets
                .snapshot_state(&credential.secret_ref)
                .map(|snapshot| (credential.secret_ref.clone(), snapshot))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let mut removed = Vec::with_capacity(snapshots.len());
    for (secret_ref, snapshot) in &snapshots {
        if let Err(error) = secrets.delete(secret_ref) {
            let mut rollback_errors = Vec::new();
            for (_, removed_snapshot) in &removed {
                if let Err(restore_error) = secrets.restore_state(removed_snapshot) {
                    log::error!(
                        "ai router: failed to restore local credential after delete rollback: {restore_error}"
                    );
                    rollback_errors.push(restore_error.to_string());
                }
            }
            if !rollback_errors.is_empty() {
                return Err(compensation_failure(
                    "AI_PROFILE_SECRET_DELETE_ROLLBACK_FAILED",
                    &error,
                    &rollback_errors.join(" | "),
                ));
            }
            return Err(error);
        }
        removed.push((secret_ref.clone(), snapshot.clone()));
    }

    let delete_result = (|| -> AppResult<()> {
        let mut conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM ai_credentials WHERE profile_id = ?1",
            params![id],
        )?;
        let changed = tx.execute("DELETE FROM ai_profiles WHERE id = ?1", params![id])?;
        if changed != 1 {
            return Err(AppError::Other("AI_PROFILE_NOT_FOUND".to_string()));
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = delete_result {
        let mut rollback_errors = Vec::new();
        for (_, snapshot) in &removed {
            if let Err(restore_error) = secrets.restore_state(snapshot) {
                log::error!(
                    "ai router: failed to restore local credential after metadata rollback: {restore_error}"
                );
                rollback_errors.push(restore_error.to_string());
            }
        }
        if !rollback_errors.is_empty() {
            return Err(compensation_failure(
                "AI_PROFILE_METADATA_DELETE_ROLLBACK_FAILED",
                &error,
                &rollback_errors.join(" | "),
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub fn add_credential(
    db: &Db,
    secrets: &Secrets,
    profile_id: String,
    label: String,
    value: String,
) -> AppResult<AiCredentialView> {
    profile_by_id(db, &profile_id)?;
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Other("AI_API_KEY_EMPTY".to_string()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let secret_ref = format!("ai_api_key/{id}");
    let timestamp = now();
    secrets.set(&secret_ref, value)?;
    let insert_result = (|| -> AppResult<i64> {
        let mut conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let tx = conn.transaction()?;
        let priority: i64 = tx.query_row(
            "SELECT COALESCE(MAX(priority) + 1, 0) FROM ai_credentials WHERE profile_id = ?1",
            params![profile_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO ai_credentials (id, profile_id, label, secret_ref, masked_suffix, enabled, priority, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'active', ?7, ?7)",
            params![id, profile_id, if label.trim().is_empty() { "API key" } else { label.trim() }, secret_ref, suffix(value), priority, timestamp],
        )?;
        tx.commit()?;
        Ok(priority)
    })();
    let priority = match insert_result {
        Ok(priority) => priority,
        Err(error) => {
            if let Err(cleanup_error) = secrets.delete(&secret_ref) {
                return Err(compensation_failure(
                    "AI_CREDENTIAL_ADD_ROLLBACK_FAILED",
                    &error,
                    &cleanup_error,
                ));
            }
            return Err(error);
        }
    };
    Ok(AiCredentialView {
        id,
        profile_id,
        label: if label.trim().is_empty() {
            "API key".to_string()
        } else {
            label
        },
        masked_suffix: suffix(value),
        enabled: true,
        priority,
        state: "active".to_string(),
        cooldown_until: None,
        last_error_kind: None,
        last_used_at: None,
    })
}

pub fn replace_credential(db: &Db, secrets: &Secrets, id: &str, value: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::Other("AI_API_KEY_EMPTY".to_string()));
    }
    let secret_ref = credential_by_id(db, id)?.secret_ref;
    // Preserve the complete local state for rollback. This includes a pending
    // legacy-import marker when the user replaces a credential without first
    // granting access to its old per-item Keychain record.
    let previous = secrets.snapshot_state(&secret_ref)?;
    secrets.set(&secret_ref, value)?;
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    if let Err(error) = conn.execute("UPDATE ai_credentials SET masked_suffix = ?1, state = 'active', cooldown_until = NULL, last_error_kind = NULL, updated_at = ?2 WHERE id = ?3", params![suffix(value), now(), id]) {
        if let Err(restore_error) = secrets.restore_state(&previous) {
            return Err(compensation_failure(
                "AI_CREDENTIAL_REPLACE_ROLLBACK_FAILED",
                &error,
                &restore_error,
            ));
        }
        return Err(error.into());
    }
    Ok(())
}

pub fn set_credential_enabled(db: &Db, id: &str, enabled: bool) -> AppResult<()> {
    let changed = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .execute(
            "UPDATE ai_credentials SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled as i64, now(), id],
        )?;
    if changed != 1 {
        return Err(AppError::Other("AI_CREDENTIAL_NOT_FOUND".to_string()));
    }
    Ok(())
}

pub fn reorder_credentials(db: &Db, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() {
        return Err(AppError::Other("AI_CREDENTIAL_ORDER_INVALID".to_string()));
    }
    let first = credential_by_id(db, &ids[0])?;
    let existing = all_credentials_for(db, &first.view.profile_id)?;
    let existing_ids: HashSet<&str> = existing
        .iter()
        .map(|credential| credential.view.id.as_str())
        .collect();
    if unique != existing_ids {
        return Err(AppError::Other(
            "AI_CREDENTIAL_ORDER_INCOMPLETE".to_string(),
        ));
    }

    let timestamp = now();
    let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let tx = conn.transaction()?;
    for (priority, id) in ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE ai_credentials SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority as i64, timestamp, id],
        )?;
        if changed != 1 {
            return Err(AppError::Other("AI_CREDENTIAL_NOT_FOUND".to_string()));
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_credential(db: &Db, secrets: &Secrets, id: &str) -> AppResult<()> {
    let secret_ref = credential_by_id(db, id)?.secret_ref;
    let snapshot = secrets.snapshot_state(&secret_ref)?;
    secrets.delete(&secret_ref)?;
    let delete_result = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .execute("DELETE FROM ai_credentials WHERE id = ?1", params![id]);
    let changed = match delete_result {
        Ok(changed) => changed,
        Err(error) => {
            if let Err(restore_error) = secrets.restore_state(&snapshot) {
                return Err(compensation_failure(
                    "AI_CREDENTIAL_DELETE_ROLLBACK_FAILED",
                    &error,
                    &restore_error,
                ));
            }
            return Err(error.into());
        }
    };
    if changed != 1 {
        let not_found = AppError::Other("AI_CREDENTIAL_NOT_FOUND".to_string());
        if let Err(restore_error) = secrets.restore_state(&snapshot) {
            return Err(compensation_failure(
                "AI_CREDENTIAL_DELETE_ROLLBACK_FAILED",
                &not_found,
                &restore_error,
            ));
        }
        return Err(not_found);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn timed_stream_once<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    profile: &AiProfile,
    api_key: &str,
    oauth_account_id: Option<&str>,
    messages: &[ChatMessage],
    event_name: &str,
    max_tokens: Option<u32>,
    persist_effort_clear: bool,
) -> (AppResult<()>, Option<u64>, u64) {
    let started = Instant::now();
    let emitted = Arc::new(AtomicBool::new(false));
    let (_cancel_guard, mut cancel) = watch::channel(false);
    // A connection test is the best place to learn which effort levels an
    // endpoint accepts: the user is sitting in settings, so the cleared value
    // and the freshly discovered options land in front of them immediately.
    let mut stream = Box::pin(stream_once_with_effort_fallback(
        app,
        db,
        profile,
        api_key,
        oauth_account_id,
        messages,
        event_name,
        max_tokens,
        profile.view.reasoning_effort.as_deref(),
        persist_effort_clear,
        Arc::clone(&emitted),
        &mut cancel,
    ));
    let mut ticker = tokio::time::interval(Duration::from_millis(2));
    let mut first_response_ms = None;
    let result = loop {
        tokio::select! {
            result = &mut stream => break result,
            _ = ticker.tick(), if first_response_ms.is_none() => {
                if emitted.load(Ordering::Relaxed) {
                    first_response_ms = Some(started.elapsed().as_millis() as u64);
                }
            }
        }
    };
    let total_ms = started.elapsed().as_millis() as u64;
    if first_response_ms.is_none() && emitted.load(Ordering::Relaxed) {
        first_response_ms = Some(total_ms);
    }
    (result, first_response_ms, total_ms)
}

fn connection_test_result(
    profile: &AiProfile,
    success: bool,
    credential_id: Option<String>,
    first_response_ms: Option<u64>,
    total_ms: u64,
    error_kind: Option<&str>,
    attempts: Vec<AiConnectionTestAttempt>,
) -> AiConnectionTestResult {
    let attempt_count = attempts.len();
    AiConnectionTestResult {
        success,
        profile_id: profile.view.id.clone(),
        provider: profile.view.provider.clone(),
        model: profile.view.model.clone(),
        credential_id,
        first_response_ms,
        total_ms,
        tested_at: now(),
        attempt_count,
        error_kind: error_kind.map(str::to_string),
        attempts,
    }
}

fn connection_test_attempt(
    credential: Option<&AiCredential>,
    error: Option<&AppError>,
    error_kind: Option<AiErrorKind>,
    latency_ms: u64,
    request_sent: bool,
    secret: Option<&str>,
) -> AiConnectionTestAttempt {
    AiConnectionTestAttempt {
        credential_id: credential.map(|value| value.view.id.clone()),
        credential_label: credential.map(|value| value.view.label.clone()),
        error_kind: error_kind.map(AiErrorKind::as_str).map(str::to_string),
        error_detail: error.map(|value| sanitized_error_detail(value, secret)),
        latency_ms,
        request_sent,
    }
}

#[allow(clippy::too_many_arguments)]
fn profile_for_connection_test(
    db: &Db,
    profile_id: &str,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    keep_alive: Option<String>,
) -> AppResult<(AiProfile, bool)> {
    let mut profile = profile_by_id(db, profile_id)?;
    let (_, provider, auth_mode, base_url, model, temperature, keep_alive) =
        normalize_profile_config(
            profile.view.label.clone(),
            provider,
            auth_mode,
            base_url,
            model,
            temperature,
            keep_alive,
        )?;
    let reasoning_effort = normalize_reasoning_effort(reasoning_effort)?;
    let uses_saved_config = profile.view.provider == provider
        && profile.view.auth_mode == auth_mode
        && profile.view.base_url == base_url
        && profile.view.model == model
        && profile.view.temperature == temperature
        && profile.view.reasoning_effort == reasoning_effort
        && profile.view.keep_alive == keep_alive;
    profile.view.provider = provider;
    profile.view.auth_mode = auth_mode;
    profile.view.base_url = base_url;
    profile.view.model = model;
    profile.view.temperature = temperature;
    profile.view.reasoning_effort = reasoning_effort;
    profile.view.keep_alive = keep_alive;
    Ok((profile, uses_saved_config))
}

#[allow(clippy::too_many_arguments)]
pub async fn test_profile<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    profile_id: &str,
    provider: String,
    auth_mode: String,
    base_url: Option<String>,
    model: String,
    temperature: f64,
    reasoning_effort: Option<String>,
    keep_alive: Option<String>,
) -> AppResult<AiConnectionTestResult> {
    let (profile, record_health) = profile_for_connection_test(
        db,
        profile_id,
        provider,
        auth_mode,
        base_url,
        model,
        temperature,
        reasoning_effort,
        keep_alive,
    )?;
    let messages = [ChatMessage {
        role: "user".to_string(),
        content: "Reply with OK.".to_string(),
    }];
    let overall_started = Instant::now();

    if profile.view.auth_mode == "oauth" && profile.view.provider == "openai" {
        let (token, account_id) = match crate::ai::oauth::get_valid_token(secrets).await {
            Ok(token) => token,
            Err(error) => {
                let kind = classify_error(&error);
                let total_ms = overall_started.elapsed().as_millis() as u64;
                if record_health {
                    update_profile_health(db, &profile, Some(kind), retry_after_ms(&error), None);
                }
                return Ok(connection_test_result(
                    &profile,
                    false,
                    None,
                    None,
                    total_ms,
                    Some(kind.as_str()),
                    vec![connection_test_attempt(
                        None,
                        Some(&error),
                        Some(kind),
                        total_ms,
                        false,
                        None,
                    )],
                ));
            }
        };
        let event_name = format!("ai-profile-test-{}", uuid::Uuid::new_v4());
        let (result, first_response_ms, _) = timed_stream_once(
            app,
            db,
            &profile,
            &token,
            account_id.as_deref(),
            &messages,
            &event_name,
            connection_test_token_limit(&profile),
            record_health,
        )
        .await;
        let total_ms = overall_started.elapsed().as_millis() as u64;
        let kind = result.as_ref().err().map(classify_error);
        let attempt = connection_test_attempt(
            None,
            result.as_ref().err(),
            kind,
            total_ms,
            true,
            Some(&token),
        );
        if record_health {
            update_profile_health(
                db,
                &profile,
                kind,
                result.as_ref().err().and_then(retry_after_ms),
                Some(total_ms),
            );
        }
        return Ok(connection_test_result(
            &profile,
            result.is_ok(),
            None,
            first_response_ms,
            total_ms,
            kind.map(AiErrorKind::as_str),
            vec![attempt],
        ));
    }

    if profile.view.provider == "ollama" {
        let event_name = format!("ai-profile-test-{}", uuid::Uuid::new_v4());
        let (result, first_response_ms, _) = timed_stream_once(
            app,
            db,
            &profile,
            "",
            None,
            &messages,
            &event_name,
            connection_test_token_limit(&profile),
            record_health,
        )
        .await;
        let total_ms = overall_started.elapsed().as_millis() as u64;
        let kind = result.as_ref().err().map(classify_error);
        let attempt =
            connection_test_attempt(None, result.as_ref().err(), kind, total_ms, true, None);
        if record_health {
            update_profile_health(
                db,
                &profile,
                kind,
                result.as_ref().err().and_then(retry_after_ms),
                Some(total_ms),
            );
        }
        return Ok(connection_test_result(
            &profile,
            result.is_ok(),
            None,
            first_response_ms,
            total_ms,
            kind.map(AiErrorKind::as_str),
            vec![attempt],
        ));
    }

    let candidates: Vec<_> = all_credentials_for(db, profile_id)?
        .into_iter()
        .filter(|credential| credential.view.enabled)
        .collect();
    if candidates.is_empty() {
        if record_health {
            update_profile_health(db, &profile, Some(AiErrorKind::NotConfigured), None, None);
        }
        return Ok(connection_test_result(
            &profile,
            false,
            None,
            None,
            overall_started.elapsed().as_millis() as u64,
            Some("not_configured"),
            Vec::new(),
        ));
    }

    let mut attempts = Vec::new();
    let mut last_credential_id = None;
    let mut last_first_response_ms = None;
    let mut last_error_kind = Some(AiErrorKind::CredentialInvalid);
    let mut last_retry_after = None;
    for credential in candidates {
        let attempt_started = Instant::now();
        last_credential_id = Some(credential.view.id.clone());
        last_first_response_ms = None;
        let key = match secrets.get(&credential.secret_ref) {
            Ok(Some(key)) if !key.trim().is_empty() => key,
            result => {
                let error = match result {
                    Err(error) => error,
                    _ => AppError::Other("AI_CREDENTIAL_UNAVAILABLE".to_string()),
                };
                if record_health {
                    update_credential_health(
                        db,
                        &credential,
                        Some(AiErrorKind::CredentialInvalid),
                        None,
                    );
                }
                attempts.push(connection_test_attempt(
                    Some(&credential),
                    Some(&error),
                    Some(AiErrorKind::CredentialInvalid),
                    attempt_started.elapsed().as_millis() as u64,
                    false,
                    None,
                ));
                last_error_kind = Some(AiErrorKind::CredentialInvalid);
                last_retry_after = None;
                continue;
            }
        };
        let event_name = format!("ai-profile-test-{}", uuid::Uuid::new_v4());
        let (result, first_response_ms, attempt_ms) = timed_stream_once(
            app,
            db,
            &profile,
            &key,
            None,
            &messages,
            &event_name,
            connection_test_token_limit(&profile),
            record_health,
        )
        .await;
        last_first_response_ms = first_response_ms;
        match result {
            Ok(()) => {
                let total_ms = overall_started.elapsed().as_millis() as u64;
                attempts.push(connection_test_attempt(
                    Some(&credential),
                    None,
                    None,
                    attempt_ms,
                    true,
                    Some(&key),
                ));
                if record_health {
                    update_credential_health(db, &credential, None, None);
                    update_profile_health(db, &profile, None, None, Some(total_ms));
                }
                return Ok(connection_test_result(
                    &profile,
                    true,
                    Some(credential.view.id),
                    first_response_ms,
                    total_ms,
                    None,
                    attempts,
                ));
            }
            Err(error) => {
                let kind = classify_error(&error);
                let retry_after = retry_after_ms(&error);
                if record_health {
                    update_credential_health(db, &credential, Some(kind), retry_after);
                }
                attempts.push(connection_test_attempt(
                    Some(&credential),
                    Some(&error),
                    Some(kind),
                    attempt_ms,
                    true,
                    Some(&key),
                ));
                last_error_kind = Some(kind);
                last_retry_after = retry_after;
                if !kind.retryable() {
                    break;
                }
            }
        }
    }
    let total_ms = overall_started.elapsed().as_millis() as u64;
    if record_health {
        if let Some(kind) = last_error_kind {
            update_profile_health(db, &profile, Some(kind), last_retry_after, Some(total_ms));
        }
    }
    Ok(connection_test_result(
        &profile,
        false,
        last_credential_id,
        last_first_response_ms,
        total_ms,
        last_error_kind.map(AiErrorKind::as_str),
        attempts,
    ))
}

pub fn has_configured_service(db: &Db) -> bool {
    let Ok(profiles) = profiles(db, true) else {
        return false;
    };
    profiles.into_iter().any(|profile| {
        if profile.view.provider == "ollama" {
            return true;
        }
        if profile.view.auth_mode == "oauth" && profile.view.provider == "openai" {
            return true;
        }
        all_credentials_for(db, &profile.view.id)
            .unwrap_or_default()
            .into_iter()
            .find(|credential| credential.view.enabled)
            .is_some()
    })
}

/// Validate that a routed stream has a locally readable credential before the
/// command detaches into a background task.
pub fn ensure_stream_credentials_accessible(db: &Db, secrets: &Secrets) -> AppResult<()> {
    let timestamp = now();
    for profile in profiles(db, true)?.into_iter().filter(|profile| {
        profile
            .view
            .cooldown_until
            .is_none_or(|deadline| deadline <= timestamp)
    }) {
        if profile.view.provider == "ollama" {
            return Ok(());
        }
        if profile.view.auth_mode == "oauth" && profile.view.provider == "openai" {
            // Probe only the first required token here. The detached OAuth path
            // reads the remaining values from the same local database.
            if secrets
                .get("oauth_access_token")?
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(());
            }
            continue;
        }
        for credential in credentials_for(db, &profile.view.id, now())? {
            if secrets
                .get(&credential.secret_ref)?
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(());
            }
        }
    }
    Ok(())
}

pub async fn test_credential<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    secrets: &Secrets,
    credential_id: &str,
) -> AppResult<()> {
    let credential = credential_by_id(db, credential_id)?;
    let profile = profile_by_id(db, &credential.view.profile_id)?;
    let key = secrets
        .get(&credential.secret_ref)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Other("AI_CREDENTIAL_UNAVAILABLE".to_string()))?;
    let messages = [ChatMessage {
        role: "user".to_string(),
        content: "Reply with OK.".to_string(),
    }];
    let event_name = format!("ai-credential-test-{}", uuid::Uuid::new_v4());
    let (result, _, total_ms) = timed_stream_once(
        app,
        db,
        &profile,
        &key,
        None,
        &messages,
        &event_name,
        connection_test_token_limit(&profile),
        true,
    )
    .await;
    update_credential_health(
        db,
        &credential,
        result.as_ref().err().map(classify_error),
        result.as_ref().err().and_then(retry_after_ms),
    );
    update_profile_health(
        db,
        &profile,
        result.as_ref().err().map(classify_error),
        result.as_ref().err().and_then(retry_after_ms),
        Some(total_ms),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn dropped_cancel_sender_does_not_cancel_request() {
        let receiver = watch::channel(false).1;
        let mut receiver = receiver;

        assert!(
            tokio::time::timeout(Duration::from_millis(20), wait_cancelled(&mut receiver),)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn live_cancel_sender_wakes_request() {
        let (sender, mut receiver) = watch::channel(false);
        sender.send(true).unwrap();

        tokio::time::timeout(Duration::from_millis(20), wait_cancelled(&mut receiver))
            .await
            .expect("cancellation should wake the request");
    }

    #[test]
    fn effort_rides_the_chat_path_and_only_spreads_when_opted_in() {
        let mut view = AiProfileView {
            id: "p".into(),
            label: "p".into(),
            provider: "custom".into(),
            auth_mode: "api_key".into(),
            base_url: Some("https://gateway.example".into()),
            model: "m".into(),
            temperature: 0.3,
            reasoning_effort: Some("high".into()),
            reasoning_effort_all_features: false,
            keep_alive: None,
            enabled: true,
            priority: 0,
            state: "active".into(),
            cooldown_until: None,
            last_error_kind: None,
            last_used_at: None,
            last_latency_ms: None,
        };

        assert_eq!(effort_for(&view, AiRequestPurpose::Chat), Some("high"));
        // A vocabulary card or an inline translation should not pay for deep
        // thinking just because the chat profile asked for it — and staying
        // quiet is not enough, because the model's own default is to think.
        assert_eq!(
            effort_for(&view, AiRequestPurpose::Utility),
            Some(NO_REASONING)
        );

        view.reasoning_effort_all_features = true;
        assert_eq!(effort_for(&view, AiRequestPurpose::Utility), Some("high"));
    }

    /// A profile with no level of its own still asks Lantern's own prompts not
    /// to think. That case is the whole point: the reader never touched the
    /// setting, and the model reasons for forty seconds over one word.
    #[test]
    fn an_unconfigured_profile_still_turns_reasoning_off_for_lanterns_own_prompts() {
        let mut view = profile("deepseek", None);
        view.reasoning_effort = None;
        assert_eq!(effort_for(&view, AiRequestPurpose::Chat), None);
        assert_eq!(
            effort_for(&view, AiRequestPurpose::Utility),
            Some(NO_REASONING)
        );

        // Opting every feature in hands the request back to the reader's
        // setting, including their decision to set nothing.
        view.reasoning_effort_all_features = true;
        assert_eq!(effort_for(&view, AiRequestPurpose::Utility), None);
    }

    #[test]
    fn a_gateway_that_listed_its_levels_is_not_asked_for_none_again() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let mut view = profile("custom", Some("https://gateway.example/v1"));
        view.model = "model-a".into();
        view.reasoning_effort = None;
        let profile = AiProfile { view };

        // Nothing learned yet: worth one attempt.
        assert!(endpoint_may_accept(&db, &profile, NO_REASONING));

        let (base_url, model) =
            effort_hint_key("custom", Some("https://gateway.example/v1"), "model-a");
        store_effort_hints(&db, &base_url, &model, &["low".into(), "high".into()]);
        // This gateway named its levels and `none` was not among them. Sending
        // it anyway would cost a rejection and a retry on every single lookup.
        assert!(!endpoint_may_accept(&db, &profile, NO_REASONING));
        assert!(endpoint_may_accept(&db, &profile, "low"));

        // A level the reader picked is always sent. Dropping it silently would
        // make their setting a lie; a rejection at least tells them.
        let mut view = profile.view.clone();
        view.reasoning_effort = Some("x-high".into());
        let chosen = AiProfile { view };
        assert!(endpoint_may_accept(&db, &chosen, "x-high"));
    }

    #[test]
    fn reasoning_effort_normalizes_case_and_rejects_junk() {
        assert_eq!(
            normalize_reasoning_effort(Some("  X-High ".into())).unwrap(),
            Some("x-high".to_string())
        );
        // Blank is "send nothing", which is not the same as the literal `none`.
        assert_eq!(
            normalize_reasoning_effort(Some("   ".into())).unwrap(),
            None
        );
        assert_eq!(
            normalize_reasoning_effort(Some("none".into())).unwrap(),
            Some("none".to_string())
        );
        assert!(normalize_reasoning_effort(Some("high\"; drop".into())).is_err());
        assert!(normalize_reasoning_effort(Some("x".repeat(33))).is_err());
    }

    #[test]
    fn supported_efforts_are_learned_from_the_rejection_body() {
        assert_eq!(
            parse_supported_values(
                "status=400 message=Invalid value: 'x-high'. Supported values are: 'low', 'medium', and 'high'."
            ),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            parse_supported_values("status=400 message=must be one of low, medium, high"),
            vec!["low", "medium", "high"]
        );
        // Most gateways say nothing useful; learning stays opportunistic.
        assert!(parse_supported_values("status=400 message=bad request").is_empty());
    }

    #[test]
    fn effort_hints_are_scoped_to_a_model_not_just_a_gateway() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();

        let (base_url, model) =
            effort_hint_key("custom", Some("https://gateway.example/v1/"), "model-a");
        store_effort_hints(&db, &base_url, &model, &["low".into(), "high".into()]);

        let hints =
            reasoning_effort_options(&db, "custom", Some("https://gateway.example/v1"), "model-a")
                .unwrap();
        assert_eq!(hints.options, vec!["low".to_string(), "high".to_string()]);
        // The UI dates the hint, so a stored row always carries a timestamp.
        assert!(hints.updated_at.is_some());
        // A sibling model on the same gateway must not inherit them.
        assert!(reasoning_effort_options(
            &db,
            "custom",
            Some("https://gateway.example/v1"),
            "model-b"
        )
        .unwrap()
        .options
        .is_empty());

        forget_reasoning_effort_options(
            &db,
            "custom",
            Some("https://gateway.example/v1"),
            "model-a",
        )
        .unwrap();
        assert!(reasoning_effort_options(
            &db,
            "custom",
            Some("https://gateway.example/v1"),
            "model-a"
        )
        .unwrap()
        .options
        .is_empty());
    }

    #[test]
    fn hint_key_falls_back_to_the_provider_default_endpoint() {
        assert_eq!(
            effort_hint_key("openai", None, "gpt-4o-mini"),
            (
                "https://api.openai.com".to_string(),
                "gpt-4o-mini".to_string()
            )
        );
    }

    #[test]
    fn cancelled_errors_are_classified_separately_from_network_failures() {
        let error = AppError::Other("AI_REQUEST_CANCELLED".to_string());

        assert_eq!(classify_error(&error), AiErrorKind::Cancelled);
        assert!(!classify_error(&error).retryable());
    }

    /// Stop and start racing each other must never both come up empty. Either
    /// the cancel finds the live request, or the registration finds the flag
    /// the cancel left behind — never neither, which is a request that keeps
    /// streaming after the reader pressed Stop.
    ///
    /// This guards the invariant, not the old bug: the window the fix closed
    /// was a few instructions wide, and running the two threads against the old
    /// code never lost a cancel in thousands of rounds. It is here so that a
    /// later change which widens that window has something to trip over.
    #[test]
    fn stop_pressed_while_a_request_is_registering_is_never_dropped() {
        for round in 0..500 {
            let request_id = format!("race-{round}");
            let gate = Arc::new(std::sync::Barrier::new(2));
            let canceller = std::thread::spawn({
                let request_id = request_id.clone();
                let gate = Arc::clone(&gate);
                move || {
                    gate.wait();
                    cancel_request(&request_id)
                }
            });
            gate.wait();
            let receiver = register_request(&request_id);
            assert!(canceller.join().unwrap());

            let stopped = *receiver.borrow() || has_pending_cancellation(&request_id);
            assert!(stopped, "round {round} lost the cancel");

            finish_request(&request_id);
            take_pending_cancellation(&request_id);
        }
    }

    fn provider_error(rest: &str) -> AppError {
        AppError::Ai(format!("AI_PROVIDER_HTTP provider=custom {rest}"))
    }

    /// A spent allowance and a request sent too fast both arrive as 429. Only
    /// the code tells them apart, and getting it wrong is expensive in both
    /// directions: a minute's cooldown on a spent quota just fails again, and
    /// an hour's cooldown on a rate limit sidelines a working key.
    #[test]
    fn a_429_is_read_by_its_code_not_by_its_status() {
        assert_eq!(
            classify_error(&provider_error("status=429 code=insufficient_quota")),
            AiErrorKind::Quota
        );
        assert_eq!(
            classify_error(&provider_error("status=429 type=rate_limit_error")),
            AiErrorKind::RateLimit
        );
        // Prose that merely mentions the word does not outrank the status.
        assert_eq!(
            classify_error(&provider_error("status=429 code=quota_rate_exceeded")),
            AiErrorKind::RateLimit
        );
        // With no status at all, the word is the only evidence there is.
        assert_eq!(
            classify_error(&AppError::Ai("monthly quota reached".to_string())),
            AiErrorKind::Quota
        );
    }

    /// The old rule matched bare `insufficient`, so anything a provider called
    /// insufficient — permissions, context length — put the key in `quota` and
    /// took it out of the route for an hour.
    #[test]
    fn insufficient_alone_is_not_a_spent_quota() {
        assert_eq!(
            classify_error(&provider_error(
                "status=400 code=insufficient_context_length"
            )),
            AiErrorKind::Request
        );
        assert_eq!(
            classify_error(&provider_error("status=403 code=insufficient_permissions")),
            AiErrorKind::Permission
        );
    }

    /// Statuses are read as numbers now, so the ones nobody listed still land
    /// in the right class: Anthropic's 529 is a provider outage, and a 4xx that
    /// named neither a key nor an allowance is a bad request — worth stopping
    /// on rather than replaying under every remaining key.
    #[test]
    fn unlisted_statuses_land_with_their_own_class() {
        assert_eq!(
            classify_error(&provider_error("status=529 type=overloaded_error")),
            AiErrorKind::Provider5xx
        );
        assert_eq!(
            classify_error(&provider_error("status=520")),
            AiErrorKind::Provider5xx
        );
        for status in ["status=405", "status=409", "status=415"] {
            let kind = classify_error(&provider_error(status));
            assert_eq!(kind, AiErrorKind::Request, "{status}");
            assert!(!kind.retryable(), "{status}");
        }
    }

    /// Locks §8.3 for the quota state too: an hour is Lantern guessing when an
    /// allowance resets, and a stated time beats a guess.
    #[test]
    fn retry_after_overrides_the_default_quota_cooldown() {
        let now = 1_000;
        assert_eq!(
            profile_health_state(Some(AiErrorKind::Quota), Some(90_000), now),
            Some(("quota", Some(now + 90_000)))
        );
    }

    /// A key and a profile reach the same verdict everywhere except one arm:
    /// "nothing is configured" is a statement about the profile, and a key that
    /// inherits it would be sidelined for a problem it cannot cause.
    #[test]
    fn credential_health_matches_profile_health_apart_from_unavailable() {
        let now = 1_000;
        for kind in [
            AiErrorKind::CredentialInvalid,
            AiErrorKind::Auth,
            AiErrorKind::Permission,
            AiErrorKind::Quota,
            AiErrorKind::RateLimit,
            AiErrorKind::Network,
            AiErrorKind::Provider5xx,
            AiErrorKind::Protocol,
            AiErrorKind::Request,
            AiErrorKind::Cancelled,
        ] {
            assert_eq!(
                credential_health_state(Some(kind), None, now),
                profile_health_state(Some(kind), None, now),
                "{}",
                kind.as_str()
            );
        }
        assert_eq!(
            profile_health_state(Some(AiErrorKind::NotConfigured), None, now),
            Some(("unavailable", None))
        );
        assert_eq!(
            credential_health_state(Some(AiErrorKind::NotConfigured), None, now),
            Some(("active", None))
        );
    }

    #[test]
    fn profile_health_distinguishes_invalid_and_unconfigured_credentials() {
        assert_eq!(
            profile_health_state(Some(AiErrorKind::CredentialInvalid), None, 1_000),
            Some(("invalid", None))
        );
        assert_eq!(
            profile_health_state(Some(AiErrorKind::NotConfigured), None, 1_000),
            Some(("unavailable", None))
        );
        assert_eq!(
            profile_health_state(Some(AiErrorKind::Cancelled), None, 1_000),
            None
        );
    }

    /// Locks §8.3: an authentication failure is not retryable on the key that
    /// produced it, but the call route as a whole can still recover. The
    /// traversal has to reach the next credential, and then the next model.
    #[test]
    fn auth_failures_do_not_end_the_traversal() {
        for kind in [
            AiErrorKind::CredentialInvalid,
            AiErrorKind::Auth,
            AiErrorKind::Permission,
        ] {
            assert!(
                may_continue_after(kind, false),
                "{} should let the route continue",
                kind.as_str()
            );
        }
    }

    #[test]
    fn rate_limits_and_outages_continue_but_malformed_requests_do_not() {
        for kind in [
            AiErrorKind::RateLimit,
            AiErrorKind::Quota,
            AiErrorKind::Network,
            AiErrorKind::Provider5xx,
            AiErrorKind::Protocol,
        ] {
            assert!(may_continue_after(kind, false), "{}", kind.as_str());
        }
        // A rejected request shape is rejected everywhere, and a cancelled one
        // was cancelled on purpose. Neither is worth another model.
        for kind in [
            AiErrorKind::Request,
            AiErrorKind::NotConfigured,
            AiErrorKind::Cancelled,
        ] {
            assert!(!may_continue_after(kind, false), "{}", kind.as_str());
        }
    }

    /// Locks §5.3: once the reader can see output — body text or a non-empty
    /// reasoning delta — no failure switches models, however recoverable.
    #[test]
    fn nothing_switches_models_once_output_has_reached_the_reader() {
        for kind in [
            AiErrorKind::RateLimit,
            AiErrorKind::Network,
            AiErrorKind::Provider5xx,
            AiErrorKind::Auth,
        ] {
            assert!(
                !may_continue_after(kind, true),
                "{} must not switch after output",
                kind.as_str()
            );
        }
    }

    /// Locks §3: a spent quota lasts about an hour and a rate limit about a
    /// minute. Collapsing them into one state would make the settings page
    /// unable to tell the user which one they are waiting out.
    #[test]
    fn quota_is_its_own_state_and_outlasts_a_rate_limit() {
        let now = 1_000;
        assert_eq!(
            profile_health_state(Some(AiErrorKind::Quota), None, now),
            Some(("quota", Some(now + 60 * 60 * 1000)))
        );
        assert_eq!(
            profile_health_state(Some(AiErrorKind::RateLimit), None, now),
            Some(("cooldown", Some(now + 60 * 1000)))
        );
    }

    /// Locks §8.3: when the provider says how long to wait, that beats our own
    /// default — it is the only recovery time anyone actually knows.
    #[test]
    fn retry_after_overrides_the_default_rate_limit_cooldown() {
        let now = 1_000;
        assert_eq!(
            profile_health_state(Some(AiErrorKind::RateLimit), Some(5_000), now),
            Some(("cooldown", Some(now + 5_000)))
        );
    }

    #[test]
    fn transport_failures_cool_down_briefly() {
        let now = 1_000;
        for kind in [
            AiErrorKind::Network,
            AiErrorKind::Provider5xx,
            AiErrorKind::Protocol,
        ] {
            assert_eq!(
                profile_health_state(Some(kind), None, now),
                Some(("cooldown", Some(now + 30 * 1000))),
                "{}",
                kind.as_str()
            );
        }
    }

    /// Locks §8.3: stopping a request is the user's own doing, and must leave
    /// no trace on a model's health — otherwise a habit of hitting Stop would
    /// slowly cool down a route that never failed.
    #[test]
    fn cancelling_writes_no_health_at_all() {
        assert_eq!(
            profile_health_state(Some(AiErrorKind::Cancelled), None, 1_000),
            None
        );
        // Same for a credential: `update_credential_health` reads the same
        // decision, so a `None` here is a write that never happens.
        assert!(!may_continue_after(AiErrorKind::Cancelled, false));
    }

    /// Locks §5.4: a retry the user asked for outranks a cooldown Lantern
    /// recorded on its own, so every deadline has already passed.
    #[test]
    fn a_manual_retry_outlasts_every_cooldown() {
        assert_eq!(cooldown_cutoff(AiRetryMode::Manual), i64::MAX);
        assert!(cooldown_cutoff(AiRetryMode::Automatic) < i64::MAX);
        assert_eq!(retry_mode(Some(true)), AiRetryMode::Manual);
        assert_eq!(retry_mode(Some(false)), AiRetryMode::Automatic);
        assert_eq!(retry_mode(None), AiRetryMode::Automatic);
    }

    /// Locks the §11 acceptance case end to end, against a real database: a
    /// free model sits ahead of a paid one, spends its quota, and the paid model
    /// takes over — then every later request inside the same hour goes straight
    /// to the paid model without retrying the spent one.
    #[test]
    fn a_spent_free_model_leaves_the_route_until_its_window_ends() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = |label: &str, model: &str| {
            let profile = create_profile(
                &db,
                label.to_string(),
                "custom".to_string(),
                "api_key".to_string(),
                Some("https://gateway.example/v1".to_string()),
                model.to_string(),
                0.2,
                None,
                false,
                None,
                true,
            )
            .unwrap();
            // A model with no key is not in the route at all, so give each one
            // something to answer with; what is under test here is the deadline.
            add_credential(
                &db,
                &secrets,
                profile.id.clone(),
                "Key".to_string(),
                format!("key-{label}"),
            )
            .unwrap();
            profile
        };
        let route = |cutoff: i64| {
            routable_profiles(&db, profiles(&db, true).unwrap(), cutoff)
                .unwrap()
                .into_iter()
                .map(|profile| profile.view.id)
                .collect::<Vec<_>>()
        };
        // Order of creation is route order, so the free model answers first.
        let free = profile("Free", "free-model");
        let paid = profile("Paid", "paid-model");

        let before = route(cooldown_cutoff(AiRetryMode::Automatic));
        assert_eq!(before, vec![free.id.clone(), paid.id.clone()]);

        // The free model spends its quota. This is the request the reader sees
        // the hand-off toast for: it expected `before[0]` and got the paid one.
        update_profile_health(
            &db,
            &profile_by_id(&db, &free.id).unwrap(),
            Some(AiErrorKind::Quota),
            None,
            None,
        );
        let spent = profile_by_id(&db, &free.id).unwrap().view;
        assert_eq!(spent.state, "quota");
        let deadline = spent.cooldown_until.expect("quota records a deadline");

        // Every later request inside the window: the paid model is now the head
        // of the route, so nothing is switched away from and nothing is
        // announced. The spent model is not called again to find that out.
        let during = route(cooldown_cutoff(AiRetryMode::Automatic));
        assert_eq!(during, vec![paid.id.clone()]);
        assert_ne!(before.first(), during.first());

        // Two exits from the window. The user asking again outranks our own
        // deadline, and the deadline itself eventually passes.
        assert_eq!(
            route(cooldown_cutoff(AiRetryMode::Manual)),
            vec![free.id.clone(), paid.id.clone()]
        );
        assert_eq!(route(deadline), vec![free.id.clone(), paid.id.clone()]);
        assert_eq!(route(deadline - 1), vec![paid.id.clone()]);
    }

    /// A model with nothing to send is not part of the route either. It used to
    /// sit at the head of it, contribute nothing to every request, and make
    /// every request look like a fresh switch away from it.
    #[test]
    fn a_model_with_no_usable_key_leaves_the_route() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = |label: &str| {
            create_profile(
                &db,
                label.to_string(),
                "custom".to_string(),
                "api_key".to_string(),
                Some("https://gateway.example/v1".to_string()),
                "model".to_string(),
                0.2,
                None,
                false,
                None,
                true,
            )
            .unwrap()
        };
        let key = |profile_id: &str| {
            add_credential(
                &db,
                &secrets,
                profile_id.to_string(),
                "Key".to_string(),
                format!("key-{profile_id}"),
            )
            .unwrap()
        };
        let route = || {
            routable_profiles(
                &db,
                profiles(&db, true).unwrap(),
                cooldown_cutoff(AiRetryMode::Automatic),
            )
            .unwrap()
            .into_iter()
            .map(|profile| profile.view.label)
            .collect::<Vec<_>>()
        };

        let empty = profile("Never given a key");
        let switched_off = profile("Key switched off");
        set_credential_enabled(&db, &key(&switched_off.id).id, false).unwrap();
        let rejected = profile("Key rejected");
        let dead = key(&rejected.id);
        update_credential_health(
            &db,
            &credential_by_id(&db, &dead.id).unwrap(),
            Some(AiErrorKind::CredentialInvalid),
            None,
        );
        let working = profile("Working");
        key(&working.id);

        assert_eq!(route(), vec!["Working".to_string()]);
        // None of them is cooling down, so none of them recovers on its own.
        for profile in [&empty, &switched_off, &rejected] {
            assert!(profile_by_id(&db, &profile.id)
                .unwrap()
                .view
                .cooldown_until
                .is_none());
        }
    }

    /// When the whole route is out, the reader is told which kind of out it is:
    /// resting ends by itself, the rest need them to do something, and the
    /// something differs.
    #[test]
    fn an_empty_route_says_which_kind_of_empty() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Only".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://gateway.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        let reason = || {
            empty_route_error(
                &db,
                &profiles(&db, true).unwrap(),
                cooldown_cutoff(AiRetryMode::Automatic),
            )
            .unwrap()
            .to_string()
        };

        assert!(reason().contains("AI_NOT_CONFIGURED"));

        let credential = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Key".to_string(),
            "key".to_string(),
        )
        .unwrap();
        set_credential_enabled(&db, &credential.id, false).unwrap();
        assert!(reason().contains("AI_KEYS_DISABLED"));

        set_credential_enabled(&db, &credential.id, true).unwrap();
        update_credential_health(
            &db,
            &credential_by_id(&db, &credential.id).unwrap(),
            Some(AiErrorKind::CredentialInvalid),
            None,
        );
        assert!(reason().contains("AI_ALL_KEYS_INVALID"));

        // A model resting outranks its keys: it comes back on its own.
        update_profile_health(
            &db,
            &profile_by_id(&db, &profile.id).unwrap(),
            Some(AiErrorKind::RateLimit),
            None,
            None,
        );
        assert!(reason().contains("AI_KEYS_COOLING_DOWN"));
    }

    /// A model the user turned off is not part of the route at all, however
    /// healthy it looks — otherwise the switch toast could name a model the
    /// user had already dismissed.
    #[test]
    fn a_disabled_model_is_not_a_fallback() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let backup = create_profile(
            &db,
            "Backup".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://gateway.example/v1".to_string()),
            "backup-model".to_string(),
            0.2,
            None,
            false,
            None,
            false,
        )
        .unwrap();

        assert!(!backup.enabled);
        assert!(profiles(&db, true).unwrap().is_empty());
        assert_eq!(profiles(&db, false).unwrap().len(), 1);
    }

    #[test]
    fn connection_attempt_serialization_is_diagnostic_and_redacted() {
        let error = AppError::Other(format!(
            "provider rejected secret-token {}",
            "x".repeat(400)
        ));
        let attempt = connection_test_attempt(
            None,
            Some(&error),
            Some(AiErrorKind::Auth),
            42,
            true,
            Some("secret-token"),
        );
        let value = serde_json::to_value(&attempt).unwrap();

        assert_eq!(value["error_kind"], "auth");
        assert_eq!(value["latency_ms"], 42);
        assert_eq!(value["request_sent"], true);
        let detail = value["error_detail"].as_str().unwrap();
        assert!(!detail.contains("secret-token"));
        assert!(detail.chars().count() <= 300);
    }

    async fn model_list_server(
        responses: Vec<(&'static str, &'static str)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(responses.len());
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 2048];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                requests.push(String::from_utf8_lossy(&request).into_owned());
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (format!("http://{address}"), handle)
    }

    fn model_list_test_profile(db: &Db, base_url: String) -> AiProfileView {
        create_profile(
            db,
            "Models".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some(base_url),
            "placeholder".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap()
    }

    fn profile(provider: &str, base_url: Option<&str>) -> AiProfileView {
        AiProfileView {
            id: "profile".to_string(),
            label: "Profile".to_string(),
            provider: provider.to_string(),
            auth_mode: "api_key".to_string(),
            base_url: base_url.map(str::to_string),
            model: "model".to_string(),
            temperature: 0.2,
            reasoning_effort: None,
            reasoning_effort_all_features: false,
            keep_alive: None,
            enabled: true,
            priority: 0,
            state: "active".to_string(),
            cooldown_until: None,
            last_error_kind: None,
            last_used_at: None,
            last_latency_ms: None,
        }
    }

    // A cap that a reasoning model can spend on thinking alone is not a cap on
    // the answer — it is a way to get no answer at all. Only Anthropic, which
    // requires the field, may see one.
    #[test]
    fn only_anthropic_is_sent_a_token_cap() {
        let capped = |provider: &str| {
            answer_token_limit(
                &AiProfile {
                    view: profile(provider, None),
                },
                Some(1536),
            )
        };
        assert_eq!(capped("anthropic"), Some(1536));
        assert_eq!(capped("deepseek"), None);
        assert_eq!(capped("openai"), None);
        assert_eq!(capped("custom"), None);
        assert_eq!(capped("ollama"), None);
        assert_eq!(
            answer_token_limit(
                &AiProfile {
                    view: profile("anthropic", None)
                },
                None
            ),
            None
        );
        assert_eq!(
            connection_test_token_limit(&AiProfile {
                view: profile("anthropic", None)
            }),
            Some(64)
        );
        assert_eq!(
            connection_test_token_limit(&AiProfile {
                view: profile("deepseek", None)
            }),
            None
        );
    }

    #[test]
    fn model_endpoints_normalize_provider_base_urls() {
        assert_eq!(
            models_endpoint(&profile("openai", None)).unwrap(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint(&profile("custom", Some("https://gateway.example/v1/"))).unwrap(),
            "https://gateway.example/v1/models"
        );
        assert_eq!(
            models_endpoint(&profile("anthropic", Some("https://api.anthropic.com/"))).unwrap(),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            models_endpoint(&profile("ollama", Some("http://localhost:11434/api/"))).unwrap(),
            "http://localhost:11434/api/tags"
        );
    }

    #[test]
    fn deepseek_uses_its_unversioned_base_and_gains_v1() {
        // DeepSeek publishes no version segment, so the helper has to add one
        // rather than leave the path bare.
        assert_eq!(
            models_endpoint(&profile("deepseek", None)).unwrap(),
            "https://api.deepseek.com/v1/models"
        );
        assert_eq!(
            resolve_base_url(&profile("deepseek", None)).unwrap(),
            DEEPSEEK_BASE_URL
        );
        // An explicitly configured base still wins over the preset default, and
        // one that already carries a version segment keeps it.
        assert_eq!(
            models_endpoint(&profile("deepseek", Some("https://proxy.example/v4"))).unwrap(),
            "https://proxy.example/v4/models"
        );
    }

    #[test]
    fn deepseek_is_an_accepted_provider_and_needs_no_base_url() {
        let normalized = normalize_profile_config(
            "DeepSeek".to_string(),
            "deepseek".to_string(),
            "api_key".to_string(),
            None,
            "deepseek-v4-flash".to_string(),
            0.3,
            None,
        )
        .expect("deepseek is a supported provider");
        assert_eq!(normalized.1, "deepseek");
        // Unlike `custom`, an empty base URL is not an error: the preset knows
        // where DeepSeek lives.
        assert_eq!(normalized.3, None);

        // OAuth stays OpenAI-only.
        assert!(normalize_profile_config(
            "DeepSeek".to_string(),
            "deepseek".to_string(),
            "oauth".to_string(),
            None,
            "deepseek-v4-flash".to_string(),
            0.3,
            None,
        )
        .is_err());
    }

    #[test]
    fn openai_model_ids_are_trimmed_sorted_and_deduplicated() {
        let value = serde_json::json!({
            "data": [
                {"id": " z-model "},
                {"id": "a-model"},
                {"id": "a-model"},
                {"id": ""},
                {"unexpected": true}
            ]
        });
        assert_eq!(
            parse_model_ids("openai", &value).unwrap(),
            vec!["a-model".to_string(), "z-model".to_string()]
        );
    }

    #[test]
    fn ollama_model_ids_accept_model_and_legacy_name_fields() {
        let value = serde_json::json!({
            "models": [
                {"model": "qwen3:latest"},
                {"name": "llama3.2:latest"}
            ]
        });
        assert_eq!(
            parse_model_ids("ollama", &value).unwrap(),
            vec!["llama3.2:latest".to_string(), "qwen3:latest".to_string()]
        );
    }

    #[test]
    fn malformed_or_empty_model_lists_are_rejected() {
        assert!(parse_model_ids("openai", &serde_json::json!({"models": []})).is_err());
        assert!(parse_model_ids("openai", &serde_json::json!({"data": []})).is_err());
    }

    #[test]
    fn deleting_credential_removes_metadata_and_local_secret() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Delete test".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        let credential = add_credential(
            &db,
            &secrets,
            profile.id,
            "Primary".to_string(),
            "secret".to_string(),
        )
        .unwrap();
        let secret_ref = credential_by_id(&db, &credential.id).unwrap().secret_ref;

        delete_credential(&db, &secrets, &credential.id).unwrap();

        assert!(credential_by_id(&db, &credential.id).is_err());
        assert_eq!(secrets.get(&secret_ref).unwrap(), None);
    }

    #[test]
    fn deleting_profile_removes_all_local_credentials() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Delete profile".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        let first = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "First".to_string(),
            "first-secret".to_string(),
        )
        .unwrap();
        let second = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Second".to_string(),
            "second-secret".to_string(),
        )
        .unwrap();
        let refs = [first.id, second.id].map(|id| credential_by_id(&db, &id).unwrap().secret_ref);

        delete_profile(&db, &secrets, &profile.id).unwrap();

        assert!(profile_by_id(&db, &profile.id).is_err());
        for secret_ref in refs {
            assert_eq!(secrets.get(&secret_ref).unwrap(), None);
        }
    }

    #[test]
    fn add_credential_reports_primary_and_cleanup_failures() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Rollback add".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_credential_insert
                 BEFORE INSERT ON ai_credentials
                 BEGIN SELECT RAISE(ABORT, 'forced metadata insert failure'); END;",
            )
            .unwrap();
        secrets.fail_next_delete_for_test();

        let error = add_credential(
            &db,
            &secrets,
            profile.id,
            "Primary".to_string(),
            "secret".to_string(),
        )
        .unwrap_err()
        .to_string();

        assert!(error.starts_with("AI_CREDENTIAL_ADD_ROLLBACK_FAILED:"));
        assert!(error.contains("forced metadata insert failure"));
        assert!(error.contains("TEST_SECRET_DELETE_FAILED"));
    }

    #[test]
    fn replace_credential_reports_primary_and_restore_failures() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Rollback replace".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        let credential = add_credential(
            &db,
            &secrets,
            profile.id,
            "Primary".to_string(),
            "old-secret".to_string(),
        )
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_credential_update
                 BEFORE UPDATE OF masked_suffix ON ai_credentials
                 BEGIN SELECT RAISE(ABORT, 'forced metadata update failure'); END;",
            )
            .unwrap();
        secrets.fail_next_restore_for_test();

        let error = replace_credential(&db, &secrets, &credential.id, "new-secret")
            .unwrap_err()
            .to_string();

        assert!(error.starts_with("AI_CREDENTIAL_REPLACE_ROLLBACK_FAILED:"));
        assert!(error.contains("forced metadata update failure"));
        assert!(error.contains("TEST_SECRET_RESTORE_FAILED"));
    }

    #[test]
    fn stream_preflight_reads_credentials_from_the_local_table() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Local credential".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        add_credential(
            &db,
            &secrets,
            profile.id,
            "Primary".to_string(),
            "secret".to_string(),
        )
        .unwrap();

        assert!(ensure_stream_credentials_accessible(&db, &secrets).is_ok());
    }

    #[test]
    fn stream_preflight_skips_missing_credentials_before_using_fallback() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let profile = create_profile(
            &db,
            "Fallback".to_string(),
            "custom".to_string(),
            "api_key".to_string(),
            Some("https://api.example/v1".to_string()),
            "model".to_string(),
            0.2,
            None,
            false,
            None,
            true,
        )
        .unwrap();
        let missing = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Missing".to_string(),
            "removed".to_string(),
        )
        .unwrap();
        let fallback = add_credential(
            &db,
            &secrets,
            profile.id,
            "Fallback".to_string(),
            "available".to_string(),
        )
        .unwrap();
        let missing_ref = credential_by_id(&db, &missing.id).unwrap().secret_ref;
        let fallback_ref = credential_by_id(&db, &fallback.id).unwrap().secret_ref;
        secrets.delete(&missing_ref).unwrap();

        assert!(ensure_stream_credentials_accessible(&db, &secrets).is_ok());
        assert_eq!(
            secrets.get(&fallback_ref).unwrap().as_deref(),
            Some("available")
        );
    }

    #[tokio::test]
    async fn model_list_tries_the_next_enabled_credential_after_auth_failure() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let (base_url, server) = model_list_server(vec![
            (
                "401 Unauthorized",
                r#"{"error":{"code":"invalid_api_key"}}"#,
            ),
            ("200 OK", r#"{"data":[{"id":"backup-model"}]}"#),
        ])
        .await;
        let profile = model_list_test_profile(&db, base_url);
        let first = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "First".to_string(),
            "bad-key".to_string(),
        )
        .unwrap();
        let second = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Second".to_string(),
            "backup-key".to_string(),
        )
        .unwrap();

        let models = list_models(
            &db,
            &secrets,
            &profile.id,
            profile.provider.clone(),
            profile.auth_mode.clone(),
            profile.base_url.clone(),
        )
        .await
        .unwrap();
        let requests = server.await.unwrap();

        assert_eq!(models, vec!["backup-model".to_string()]);
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("Bearer bad-key"));
        assert!(requests[1].contains("Bearer backup-key"));
        let credentials = list_credentials(&db, Some(&profile.id)).unwrap();
        assert_eq!(credentials[0].id, first.id);
        assert_eq!(credentials[0].state, "active");
        assert!(credentials[0].last_used_at.is_none());
        assert_eq!(credentials[1].id, second.id);
        assert_eq!(credentials[1].state, "active");
        assert!(credentials[1].last_used_at.is_none());
    }

    #[tokio::test]
    async fn model_list_does_not_rotate_keys_for_request_errors() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let (base_url, server) = model_list_server(vec![(
            "400 Bad Request",
            r#"{"error":{"code":"invalid_endpoint"}}"#,
        )])
        .await;
        let profile = model_list_test_profile(&db, base_url);
        add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "First".to_string(),
            "first-key".to_string(),
        )
        .unwrap();
        add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Second".to_string(),
            "second-key".to_string(),
        )
        .unwrap();

        let error = list_models(
            &db,
            &secrets,
            &profile.id,
            profile.provider.clone(),
            profile.auth_mode.clone(),
            profile.base_url.clone(),
        )
        .await
        .unwrap_err();
        let requests = server.await.unwrap();

        assert!(error.to_string().contains("status=400"));
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Bearer first-key"));
        let credentials = list_credentials(&db, Some(&profile.id)).unwrap();
        assert!(credentials[0].last_error_kind.is_none());
        assert!(credentials[0].last_used_at.is_none());
        assert!(credentials[1].last_used_at.is_none());
    }

    /// Like `model_list_server`, but the count of requests that actually
    /// arrived is readable without joining the task — a router that stops
    /// early leaves the remaining responses unclaimed, and the test has to be
    /// able to see that without waiting for a connection that never comes.
    async fn counting_stream_server(
        responses: Vec<(&'static str, String)>,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        tokio::spawn(async move {
            for (status, body) in responses {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::Relaxed);
                let mut request = Vec::new();
                let mut buffer = [0_u8; 2048];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{address}"), seen)
    }

    fn sse_answer(text: &str) -> String {
        format!("{}data: [DONE]\n\n", sse_delta(text))
    }

    async fn route_test_setup(
        directory: &tempfile::TempDir,
        responses: Vec<(&'static str, String)>,
    ) -> (Db, Secrets, Arc<std::sync::atomic::AtomicUsize>, String) {
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let (base_url, seen) = counting_stream_server(responses).await;
        (db, secrets, seen, base_url)
    }

    async fn route(
        app: &tauri::App<tauri::test::MockRuntime>,
        db: &Db,
        secrets: &Secrets,
    ) -> AppResult<AiProfileView> {
        let (_sender, mut cancel) = watch::channel(false);
        stream_with_failover_inner(
            app.handle(),
            db,
            secrets,
            &[crate::commands::ai::ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            "ai-route-test",
            None,
            AiRequestPurpose::Chat,
            AiRetryMode::Automatic,
            &mut cancel,
        )
        .await
    }

    /// The first exit from the traversal: a key that is no longer a key hands
    /// the request to the next one under the same model, and says so in its own
    /// health rather than the model's.
    #[tokio::test]
    async fn a_dead_key_hands_the_request_to_the_next_one() {
        let directory = tempfile::TempDir::new().unwrap();
        let (db, secrets, seen, base_url) = route_test_setup(
            &directory,
            vec![
                (
                    "401 Unauthorized",
                    r#"{"error":{"code":"invalid_api_key"}}"#.to_string(),
                ),
                ("200 OK", sse_answer("answered")),
            ],
        )
        .await;
        let profile = model_list_test_profile(&db, base_url);
        for (label, value) in [("First", "dead-key"), ("Second", "live-key")] {
            add_credential(
                &db,
                &secrets,
                profile.id.clone(),
                label.to_string(),
                value.to_string(),
            )
            .unwrap();
        }

        let app = tauri::test::mock_app();
        let answered = route(&app, &db, &secrets).await.unwrap();

        assert_eq!(answered.id, profile.id);
        assert_eq!(seen.load(Ordering::Relaxed), 2);
        let credentials = list_credentials(&db, Some(&profile.id)).unwrap();
        assert_eq!(credentials[0].state, "invalid");
        assert_eq!(
            credentials[0].last_error_kind.as_deref(),
            Some("credential_invalid")
        );
        assert_eq!(credentials[1].state, "active");
        assert!(credentials[1].last_used_at.is_some());
        // The model itself answered, so nothing is wrong with the model.
        let stored = profile_by_id(&db, &profile.id).unwrap().view;
        assert_eq!(stored.state, "active");
        assert!(stored.last_latency_ms.is_some());
    }

    /// The second exit: a model that is down hands the request to the next
    /// model, and the one that answers is not the one the reader expected.
    #[tokio::test]
    async fn a_model_that_is_down_hands_the_request_to_the_next_model() {
        let directory = tempfile::TempDir::new().unwrap();
        let (db, secrets, seen, base_url) = route_test_setup(
            &directory,
            vec![
                ("503 Service Unavailable", "{}".to_string()),
                ("200 OK", sse_answer("answered")),
            ],
        )
        .await;
        let first = model_list_test_profile(&db, base_url.clone());
        let second = model_list_test_profile(&db, base_url);
        for profile in [&first, &second] {
            add_credential(
                &db,
                &secrets,
                profile.id.clone(),
                "Key".to_string(),
                format!("key-{}", profile.id),
            )
            .unwrap();
        }

        let app = tauri::test::mock_app();
        let answered = route(&app, &db, &secrets).await.unwrap();

        assert_eq!(answered.id, second.id);
        assert_eq!(seen.load(Ordering::Relaxed), 2);
        let down = profile_by_id(&db, &first.id).unwrap().view;
        assert_eq!(down.state, "cooldown");
        assert_eq!(down.last_error_kind.as_deref(), Some("provider_5xx"));
        assert_eq!(profile_by_id(&db, &second.id).unwrap().view.state, "active");
    }

    /// The third exit: a request the provider refused on its shape is refused
    /// on its shape everywhere, so the route stops instead of spending every
    /// remaining key and model on the same rejected bytes — and nothing is
    /// cooled down for it, because nothing failed.
    #[tokio::test]
    async fn a_refused_request_stops_the_route_instead_of_touring_it() {
        let directory = tempfile::TempDir::new().unwrap();
        let (db, secrets, seen, base_url) = route_test_setup(
            &directory,
            vec![
                (
                    "400 Bad Request",
                    r#"{"error":{"code":"context_length_exceeded"}}"#.to_string(),
                ),
                ("200 OK", sse_answer("never reached")),
            ],
        )
        .await;
        let first = model_list_test_profile(&db, base_url.clone());
        let second = model_list_test_profile(&db, base_url);
        for profile in [&first, &second] {
            for label in ["A", "B"] {
                add_credential(
                    &db,
                    &secrets,
                    profile.id.clone(),
                    label.to_string(),
                    format!("key-{}-{label}", profile.id),
                )
                .unwrap();
            }
        }

        let app = tauri::test::mock_app();
        let error = route(&app, &db, &secrets).await.unwrap_err();

        assert!(error.to_string().contains("status=400"));
        assert_eq!(seen.load(Ordering::Relaxed), 1);
        for profile in [&first, &second] {
            assert_eq!(
                profile_by_id(&db, &profile.id).unwrap().view.state,
                "active"
            );
            for credential in list_credentials(&db, Some(&profile.id)).unwrap() {
                assert_eq!(credential.state, "active", "{}", credential.label);
            }
        }
    }

    /// A key whose secret is gone is not a key. It is marked and skipped, and
    /// the model is still reached through the next one.
    #[tokio::test]
    async fn a_key_whose_secret_vanished_is_marked_and_skipped() {
        let directory = tempfile::TempDir::new().unwrap();
        let (db, secrets, seen, base_url) =
            route_test_setup(&directory, vec![("200 OK", sse_answer("answered"))]).await;
        let profile = model_list_test_profile(&db, base_url);
        let missing = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Gone".to_string(),
            "about-to-vanish".to_string(),
        )
        .unwrap();
        add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Present".to_string(),
            "live-key".to_string(),
        )
        .unwrap();
        secrets
            .delete(&format!("ai_api_key/{}", missing.id))
            .unwrap();

        let app = tauri::test::mock_app();
        route(&app, &db, &secrets).await.unwrap();

        assert_eq!(seen.load(Ordering::Relaxed), 1);
        let credentials = list_credentials(&db, Some(&profile.id)).unwrap();
        assert_eq!(credentials[0].state, "invalid");
        assert_eq!(credentials[1].state, "active");
    }

    /// The rule the announcement bookkeeping follows, case by case. Keys are
    /// unique to this test because the table outlives it.
    #[test]
    fn a_switch_is_news_only_when_its_reason_changed() {
        let deadline = now() + 60_000;
        // Two requests that failed together get one notice between them.
        assert!(fallback_is_news("news-cooling", "to", Some(deadline)));
        assert!(!fallback_is_news("news-cooling", "to", Some(deadline)));
        // A different destination is a different piece of news.
        assert!(fallback_is_news(
            "news-cooling",
            "elsewhere",
            Some(deadline)
        ));
        // Once the deadline the reader was given has passed, a failure is a new
        // outage rather than the tail of the old one.
        assert!(fallback_is_news("news-expired", "to", Some(now() - 1)));
        assert!(fallback_is_news("news-expired", "to", Some(deadline)));
        // A model that fails without earning a cooldown loses every request
        // from now on; saying so once is enough.
        assert!(fallback_is_news("news-broken", "to", None));
        assert!(!fallback_is_news("news-broken", "to", None));
        // Until it does earn one, which the reader has not been told.
        assert!(fallback_is_news("news-broken", "to", Some(deadline)));
    }

    /// A model whose every key is invalid earns no cooldown, so it is never
    /// filtered out of the route and loses every later request too. Announcing
    /// that per request is a notice that never stops; the reader hears it once.
    #[tokio::test]
    async fn a_model_that_keeps_losing_the_route_is_announced_only_once() {
        let directory = tempfile::TempDir::new().unwrap();
        let (db, secrets, seen, base_url) = route_test_setup(
            &directory,
            vec![
                ("200 OK", sse_answer("first")),
                ("200 OK", sse_answer("second")),
            ],
        )
        .await;
        let first = model_list_test_profile(&db, base_url.clone());
        let second = model_list_test_profile(&db, base_url);
        let gone = add_credential(
            &db,
            &secrets,
            first.id.clone(),
            "Gone".to_string(),
            "about-to-vanish".to_string(),
        )
        .unwrap();
        add_credential(
            &db,
            &secrets,
            second.id.clone(),
            "Live".to_string(),
            "live-key".to_string(),
        )
        .unwrap();
        secrets.delete(&format!("ai_api_key/{}", gone.id)).unwrap();

        let app = tauri::test::mock_app();
        let announced = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&announced);
        app.listen("ai-route-fallback", move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
        });

        for _ in 0..2 {
            assert_eq!(route(&app, &db, &secrets).await.unwrap().id, second.id);
        }

        // The switch happened both times — only the notice is deduplicated.
        assert_eq!(seen.load(Ordering::Relaxed), 2);
        assert!(profile_by_id(&db, &first.id)
            .unwrap()
            .view
            .cooldown_until
            .is_none());
        assert_eq!(announced.load(Ordering::Relaxed), 1);
    }

    fn sse_delta(text: &str) -> String {
        format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}}}}]}}\n\n")
    }

    /// A truncated stream is retryable in the abstract — but not once its words
    /// have already reached the reader. `complete_with_profile` accumulates
    /// every delta into one buffer for the whole call, so a second key picking
    /// up from scratch would append a whole answer to the first one's half.
    #[tokio::test]
    async fn a_stream_that_already_reached_the_reader_does_not_restart_on_the_next_key() {
        let directory = tempfile::TempDir::new().unwrap();
        let db = Db::init(directory.path()).unwrap();
        let secrets = Secrets::init_in_memory().unwrap();
        let (base_url, seen) = counting_stream_server(vec![
            // Half an answer, then the connection ends without `[DONE]`.
            ("200 OK", sse_delta("first half")),
            // The backup key would have answered in full — reaching it at all
            // is the bug.
            (
                "200 OK",
                format!("{}data: [DONE]\n\n", sse_delta("second half")),
            ),
        ])
        .await;
        let profile = model_list_test_profile(&db, base_url);
        let first = add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "First".to_string(),
            "first-key".to_string(),
        )
        .unwrap();
        add_credential(
            &db,
            &secrets,
            profile.id.clone(),
            "Second".to_string(),
            "second-key".to_string(),
        )
        .unwrap();

        let app = tauri::test::mock_app();
        let (_sender, mut cancel) = watch::channel(false);
        let error = stream_with_profile_inner(
            app.handle(),
            &db,
            &secrets,
            &profile.id,
            &[crate::commands::ai::ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            "ai-stream-test",
            None,
            &mut cancel,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("AI_STREAM_INCOMPLETE"));
        assert_eq!(seen.load(Ordering::Relaxed), 1);

        // The attempt is also recorded now, which it was not before: the key
        // that dropped the stream cools off, and the profile carries the same
        // verdict so the routed path can see it.
        let credentials = list_credentials(&db, Some(&profile.id)).unwrap();
        assert_eq!(credentials[0].id, first.id);
        assert_eq!(credentials[0].state, "cooldown");
        assert_eq!(credentials[0].last_error_kind.as_deref(), Some("protocol"));
        assert!(credentials[0].last_used_at.is_some());
        assert_eq!(credentials[1].state, "active");
        assert!(credentials[1].last_used_at.is_none());

        let stored = profile_by_id(&db, &profile.id).unwrap().view;
        assert_eq!(stored.state, "cooldown");
        assert_eq!(stored.last_error_kind.as_deref(), Some("protocol"));
    }
}
