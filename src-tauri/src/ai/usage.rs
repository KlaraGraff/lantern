//! Best-effort recording of provider `usage` objects.
//!
//! The one rule: store the provider's `usage` JSON as-is, without
//! cherry-picking fields. Billing rules change under us — cache hits,
//! tiered pricing, reasoning tokens, fields providers haven't invented yet —
//! so the raw object is the only thing worth treating as truth.
//! `input_tokens`/`output_tokens` are a best-effort projection kept only so
//! `SELECT SUM(...)` doesn't need to parse JSON per row; when extraction
//! fails they're 0 and the row is still kept, because `usage_json` is what's
//! authoritative.
//!
//! Recording must never fail the AI call it rides along with. Every
//! function here that can fail swallows its own error and logs at debug
//! level instead of propagating — a dropped usage row is fine, a broken
//! chat reply is not.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::db::Db;
use crate::error::AppResult;

/// Merge a newly-observed `usage` fragment into the per-call accumulator.
///
/// Some providers (Anthropic) split usage across two SSE events — an early
/// one with input tokens, a later one with the final output tokens — so this
/// merges object keys rather than overwriting the whole value: keys from
/// `incoming` win over whatever was already there. A non-object payload (or
/// an empty slot) just replaces outright.
pub(crate) fn merge_into(slot: &Mutex<Option<serde_json::Value>>, incoming: serde_json::Value) {
    let Ok(mut guard) = slot.lock() else {
        return;
    };
    match (&mut *guard, incoming) {
        (Some(serde_json::Value::Object(existing)), serde_json::Value::Object(new)) => {
            for (key, value) in new {
                existing.insert(key, value);
            }
        }
        (slot, incoming) => *slot = Some(incoming),
    }
}

/// Best-effort input/output token extraction, tolerant of both shapes seen
/// in the wild: Anthropic and the OpenAI Responses API use
/// `input_tokens`/`output_tokens`; OpenAI-compatible chat/completions APIs
/// (OpenAI itself, Ollama, DeepSeek, custom endpoints) use
/// `prompt_tokens`/`completion_tokens`. Anything unrecognized or missing
/// comes back as 0 rather than an error — this is only a fast-sum
/// projection, never the source of truth.
fn extract_tokens(usage: &serde_json::Value) -> (i64, i64) {
    let as_i64 =
        |key: &str| usage.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0);
    let input = if usage.get("input_tokens").is_some() {
        as_i64("input_tokens")
    } else {
        as_i64("prompt_tokens")
    };
    let output = if usage.get("output_tokens").is_some() {
        as_i64("output_tokens")
    } else {
        as_i64("completion_tokens")
    };
    (input, output)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Persist one call's usage, if any was captured.
///
/// `usage` is `None` whenever the provider never sent one (or the stream
/// failed before any arrived) — that's the ordinary case for a plain
/// `stream_options`-less request against an endpoint that omits it, so it is
/// logged at debug and skipped, not treated as a bug. Any DB error is
/// likewise swallowed: a write failure here must never turn an otherwise
/// successful AI reply into a failed command.
pub(crate) fn record(
    db: &Db,
    usage: Option<serde_json::Value>,
    provider: &str,
    model: &str,
    origin: &str,
    feature: &str,
) {
    let Some(usage) = usage else {
        log::debug!(
            "ai usage: no usage object captured (provider={provider}, feature={feature})"
        );
        return;
    };
    let usage_json = match serde_json::to_string(&usage) {
        Ok(json) => json,
        Err(error) => {
            log::debug!("ai usage: failed to serialize usage object: {error}");
            return;
        }
    };
    let (input_tokens, output_tokens) = extract_tokens(&usage);
    let conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(error) => {
            log::debug!("ai usage: db mutex poisoned, skipping record: {error}");
            return;
        }
    };
    if let Err(error) = conn.execute(
        "INSERT INTO ai_usage_records
            (id, created_at, provider, model, origin, feature, usage_json, input_tokens, output_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            now_ms(),
            provider,
            model,
            origin,
            feature,
            usage_json,
            input_tokens,
            output_tokens,
        ],
    ) {
        log::debug!("ai usage: failed to record: {error}");
    }
}

/// Token totals grouped by call origin, since `since_ms` (inclusive).
///
/// The upcoming auto-analysis console uses this to show its usage as
/// "equivalent to X% of your manual lookups" — `user` is every existing
/// button-triggered call, `auto` is reserved for the system-initiated
/// analysis that isn't wired up yet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct AiUsageSummary {
    pub user_input: i64,
    pub user_output: i64,
    pub auto_input: i64,
    pub auto_output: i64,
}

/// Sum `input_tokens`/`output_tokens` by `origin` for rows created at or
/// after `since_ms`. Origins other than `user`/`auto` are ignored rather
/// than guessed at — today nothing writes anything else.
pub fn summary(db: &Db, since_ms: i64) -> AppResult<AiUsageSummary> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT origin, COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
         FROM ai_usage_records
         WHERE created_at >= ?1
         GROUP BY origin",
    )?;
    let mut out = AiUsageSummary::default();
    let rows = stmt.query_map(params![since_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (origin, input_tokens, output_tokens) = row?;
        match origin.as_str() {
            "auto" => {
                out.auto_input = input_tokens;
                out.auto_output = output_tokens;
            }
            "user" => {
                out.user_input = input_tokens;
                out.user_output = output_tokens;
            }
            _ => {}
        }
    }
    Ok(out)
}

/// One feature's call count and token totals within a window.
///
/// `calls` counts *recorded* calls, not attempted ones: a provider that never
/// sent a `usage` object leaves no row behind (see `record`). The console
/// says "about" in front of every one of these numbers for that reason.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureUsage {
    pub feature: String,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Per-feature rollup for one origin, since `since_ms` (inclusive).
///
/// The auto-analysis console needs this on top of `summary`: the headline
/// ratio is an origin total, but each row in the console has to answer "how
/// much did *this* job cost", and only `feature` distinguishes them.
pub fn by_feature(db: &Db, since_ms: i64, origin: &str) -> AppResult<Vec<FeatureUsage>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT feature,
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0)
         FROM ai_usage_records
         WHERE created_at >= ?1 AND origin = ?2
         GROUP BY feature",
    )?;
    let rows = stmt.query_map(params![since_ms, origin], |row| {
        Ok(FeatureUsage {
            feature: row.get(0)?,
            calls: row.get(1)?,
            input_tokens: row.get(2)?,
            output_tokens: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    #[test]
    fn merge_into_combines_anthropic_two_event_split() {
        let slot = Mutex::new(None);
        merge_into(
            &slot,
            serde_json::json!({"input_tokens": 120, "cache_read_input_tokens": 40}),
        );
        merge_into(&slot, serde_json::json!({"output_tokens": 55}));
        let merged = slot.lock().unwrap().clone().unwrap();
        assert_eq!(merged["input_tokens"], 120);
        assert_eq!(merged["cache_read_input_tokens"], 40);
        assert_eq!(merged["output_tokens"], 55);
    }

    #[test]
    fn extract_tokens_reads_anthropic_shape() {
        let usage = serde_json::json!({"input_tokens": 12, "output_tokens": 34});
        assert_eq!(extract_tokens(&usage), (12, 34));
    }

    #[test]
    fn extract_tokens_reads_openai_shape() {
        let usage = serde_json::json!({"prompt_tokens": 56, "completion_tokens": 78});
        assert_eq!(extract_tokens(&usage), (56, 78));
    }

    #[test]
    fn extract_tokens_defaults_to_zero_when_fields_absent() {
        let usage = serde_json::json!({"weird_future_field": 1});
        assert_eq!(extract_tokens(&usage), (0, 0));
    }

    #[test]
    fn record_stores_the_usage_json_as_is_without_reshaping() {
        let (_dir, db) = test_db();
        let usage = serde_json::json!({
            "input_tokens": 10,
            "output_tokens": 20,
            "cache_creation_input_tokens": 5,
            "some_future_field": {"nested": true}
        });
        record(&db, Some(usage.clone()), "anthropic", "claude-x", "user", "chat");

        let conn = db.conn.lock().unwrap();
        let stored_json: String = conn
            .query_row(
                "SELECT usage_json FROM ai_usage_records WHERE provider = 'anthropic'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let round_tripped: serde_json::Value = serde_json::from_str(&stored_json).unwrap();
        assert_eq!(round_tripped, usage);
    }

    #[test]
    fn record_extracts_projected_columns_from_openai_shape() {
        let (_dir, db) = test_db();
        let usage = serde_json::json!({"prompt_tokens": 7, "completion_tokens": 9});
        record(&db, Some(usage), "openai_compat", "gpt-x", "auto", "vocabulary_scan");

        let conn = db.conn.lock().unwrap();
        let (origin, feature, input_tokens, output_tokens): (String, String, i64, i64) = conn
            .query_row(
                "SELECT origin, feature, input_tokens, output_tokens FROM ai_usage_records WHERE provider = 'openai_compat'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(origin, "auto");
        assert_eq!(feature, "vocabulary_scan");
        assert_eq!(input_tokens, 7);
        assert_eq!(output_tokens, 9);
    }

    #[test]
    fn record_with_no_usage_does_not_crash_or_write_a_row() {
        let (_dir, db) = test_db();
        record(&db, None, "openai_compat", "gpt-x", "user", "chat");

        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_usage_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn summary_groups_by_origin_and_ignores_older_rows() {
        let (_dir, db) = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let insert = |origin: &str, created_at: i64, input: i64, output: i64| {
                conn.execute(
                    "INSERT INTO ai_usage_records (id, created_at, provider, model, origin, feature, usage_json, input_tokens, output_tokens)
                     VALUES (?1, ?2, 'anthropic', 'claude-x', ?3, 'chat', '{}', ?4, ?5)",
                    params![uuid::Uuid::new_v4().to_string(), created_at, origin, input, output],
                )
                .unwrap();
            };
            insert("user", 1_000, 10, 20);
            insert("user", 2_000, 5, 8);
            insert("auto", 2_500, 100, 200);
            // Before the window: must not be counted.
            insert("user", 500, 999, 999);
        }

        let result = summary(&db, 1_000).unwrap();
        assert_eq!(
            result,
            AiUsageSummary {
                user_input: 15,
                user_output: 28,
                auto_input: 100,
                auto_output: 200,
            }
        );
    }
}
