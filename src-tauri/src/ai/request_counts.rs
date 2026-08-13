//! Lightweight per-month, per-feature counter of AI requests actually
//! initiated by this app.
//!
//! Distinct from [`crate::ai::usage`]: that module records token spend and
//! only writes a row when a provider actually returned a `usage` object, so
//! it undercounts requests. This one increments once per user-visible AI
//! request — a streamed reply counts once even when failover retries the
//! same logical request across providers or credentials, because the
//! increment happens once per call into the router choke point, before any
//! per-provider/per-credential attempt.
//!
//! Recording must never fail the AI call it rides along with — every
//! fallible path here swallows its own error and logs at debug level
//! instead of propagating.

use chrono::{DateTime, Datelike, Local};
use rusqlite::params;

use crate::db::Db;
use crate::error::AppResult;

/// `'%Y-%m'` in the *local* timezone — the reader cares about their own
/// "this month", not UTC's.
fn month_key(now: DateTime<Local>) -> String {
    now.format("%Y-%m").to_string()
}

fn previous_month_key(now: DateTime<Local>) -> String {
    let (year, month) = (now.year(), now.month());
    let (prev_year, prev_month) = if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    };
    format!("{prev_year:04}-{prev_month:02}")
}

/// Maps the many internal `origin`/`feature` literals threaded through
/// `router.rs` call sites onto the seven stable, user-facing slugs this
/// counter tracks. `None` means the call is intentionally out of this
/// lightweight counter's scope (background/utility calls with no direct
/// per-feature reassurance row, e.g. `optimize_prompt`, `word_forms`,
/// `vocab_gloss`, `book_summary`).
///
/// `feature` slugs are stored as-is in `ai_request_counts.feature` and
/// translated at display time by the frontend — never renamed once chosen.
pub(crate) fn counted_feature(origin: &str, feature: &str) -> Option<&'static str> {
    // Every background/auto-triggered call folds into one bucket regardless
    // of which job produced it — the settings row exists to reassure about
    // *manual* AI spend; auto-analysis already has its own richer console.
    if origin == "auto" {
        return Some("autoAnalysis");
    }
    match feature {
        "learning_card" => Some("dictionary"),
        "explain" => Some("explain"),
        "translate" => Some("translate"),
        "xray" => Some("xray"),
        "reading_review" => Some("review"),
        // Chat itself, plus the chat-surface-adjacent calls a chat session
        // can trigger as part of one user action (vocabulary extraction from
        // a reply, intent routing, title generation, a custom chat action).
        "chat" | "vocabulary_scan" | "intent" | "title" | "custom_action" => Some("chat"),
        // Anything else is still a real paid request — a reassurance total
        // that silently omits some spends is worse than none. Fold the
        // long tail (prompt optimization, word forms, glosses, book
        // summaries, future features) into one honest bucket.
        _ => Some("other"),
    }
}

/// Increment this month's counter for `feature` by one.
fn increment(db: &Db, feature: &str) {
    let month = month_key(Local::now());
    let conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(error) => {
            log::debug!("ai request counts: db mutex poisoned, skipping increment: {error}");
            return;
        }
    };
    if let Err(error) = conn.execute(
        "INSERT INTO ai_request_counts (month, feature, count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(month, feature) DO UPDATE SET count = count + 1",
        params![month, feature],
    ) {
        log::debug!("ai request counts: failed to increment: {error}");
    }
}

/// Maps then increments, doing nothing when the call is out of this
/// counter's scope. The one entry point router choke points call.
pub(crate) fn record(db: &Db, origin: &str, feature: &str) {
    if let Some(slug) = counted_feature(origin, feature) {
        increment(db, slug);
    }
}

/// One feature's request count within a month.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureRequestCount {
    pub feature: String,
    pub count: i64,
}

/// One month's total plus per-feature breakdown.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthRequestCounts {
    pub month: String,
    pub total: i64,
    pub by_feature: Vec<FeatureRequestCount>,
}

fn month_counts(db: &Db, month: &str) -> AppResult<MonthRequestCounts> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT feature, count FROM ai_request_counts
         WHERE month = ?1
         ORDER BY count DESC, feature ASC",
    )?;
    let rows = stmt.query_map(params![month], |row| {
        Ok(FeatureRequestCount {
            feature: row.get(0)?,
            count: row.get(1)?,
        })
    })?;
    let by_feature = rows.collect::<Result<Vec<_>, _>>()?;
    let total = by_feature.iter().map(|row| row.count).sum();
    Ok(MonthRequestCounts {
        month: month.to_string(),
        total,
        by_feature,
    })
}

/// Current month's total + per-feature breakdown, and the previous month's
/// total for context — enough for the settings row to say "N this month" and
/// (optionally) how that compares to last month, without exposing raw SQL to
/// the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequestCountsSummary {
    pub current: MonthRequestCounts,
    pub previous_total: i64,
}

pub fn summary(db: &Db) -> AppResult<AiRequestCountsSummary> {
    let now = Local::now();
    let current = month_counts(db, &month_key(now))?;
    let previous_total = month_counts(db, &previous_month_key(now))?.total;
    Ok(AiRequestCountsSummary {
        current,
        previous_total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    #[test]
    fn counted_feature_maps_known_slugs() {
        assert_eq!(counted_feature("user", "learning_card"), Some("dictionary"));
        assert_eq!(counted_feature("user", "explain"), Some("explain"));
        assert_eq!(counted_feature("user", "translate"), Some("translate"));
        assert_eq!(counted_feature("user", "xray"), Some("xray"));
        assert_eq!(counted_feature("user", "reading_review"), Some("review"));
        assert_eq!(counted_feature("user", "chat"), Some("chat"));
        assert_eq!(counted_feature("user", "vocabulary_scan"), Some("chat"));
        assert_eq!(counted_feature("user", "intent"), Some("chat"));
        assert_eq!(counted_feature("user", "title"), Some("chat"));
        assert_eq!(counted_feature("user", "custom_action"), Some("chat"));
    }

    #[test]
    fn counted_feature_folds_every_auto_origin_call_into_auto_analysis() {
        // Even a feature literal that would map to something else when
        // user-triggered (e.g. "reading_review") still counts as background
        // auto-analysis spend when it fired on its own.
        assert_eq!(
            counted_feature("auto", "reading_review"),
            Some("autoAnalysis")
        );
        assert_eq!(
            counted_feature("auto", "followup_difficulty"),
            Some("autoAnalysis")
        );
    }

    #[test]
    fn counted_feature_folds_the_long_tail_into_other() {
        assert_eq!(counted_feature("user", "optimize_prompt"), Some("other"));
        assert_eq!(counted_feature("user", "word_forms"), Some("other"));
        assert_eq!(counted_feature("user", "vocab_gloss"), Some("other"));
        assert_eq!(counted_feature("user", "book_summary"), Some("other"));
        assert_eq!(
            counted_feature("user", "some_future_feature"),
            Some("other")
        );
    }

    #[test]
    fn record_upserts_and_accumulates_within_a_month() {
        let (_dir, db) = test_db();
        record(&db, "user", "explain");
        record(&db, "user", "explain");
        record(&db, "user", "translate");
        // Long-tail feature: counts under "other", never under its raw slug.
        record(&db, "user", "word_forms");

        let month = month_key(Local::now());
        let counts = month_counts(&db, &month).unwrap();
        assert_eq!(counts.total, 4);
        let explain = counts
            .by_feature
            .iter()
            .find(|row| row.feature == "explain")
            .unwrap();
        assert_eq!(explain.count, 2);
        let translate = counts
            .by_feature
            .iter()
            .find(|row| row.feature == "translate")
            .unwrap();
        assert_eq!(translate.count, 1);
        let other = counts
            .by_feature
            .iter()
            .find(|row| row.feature == "other")
            .unwrap();
        assert_eq!(other.count, 1);
        assert!(counts
            .by_feature
            .iter()
            .all(|row| row.feature != "word_forms"));
    }

    #[test]
    fn failover_within_one_request_counts_once() {
        // The router choke point calls `record` exactly once per logical
        // request, regardless of how many providers/credentials it tried
        // underneath — this simulates that by calling `record` once for a
        // "request" that internally failed over twice before succeeding.
        let (_dir, db) = test_db();
        record(&db, "user", "chat"); // one logical request, after failover succeeded

        let month = month_key(Local::now());
        let counts = month_counts(&db, &month).unwrap();
        assert_eq!(counts.total, 1);
        assert_eq!(counts.by_feature[0].count, 1);
    }

    #[test]
    fn month_rollover_keeps_counts_in_separate_buckets() {
        let (_dir, db) = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO ai_request_counts (month, feature, count) VALUES ('2026-07', 'chat', 5)",
                [],
            )
            .unwrap();
        }
        record(&db, "user", "chat");

        let july = month_counts(&db, "2026-07").unwrap();
        assert_eq!(july.total, 5);
        let current = month_counts(&db, &month_key(Local::now())).unwrap();
        assert_eq!(current.total, 1);
    }

    #[test]
    fn previous_month_key_wraps_across_a_year_boundary() {
        let january = Local.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap();
        assert_eq!(previous_month_key(january), "2025-12");
        let august = Local.with_ymd_and_hms(2026, 8, 7, 0, 0, 0).unwrap();
        assert_eq!(previous_month_key(august), "2026-07");
    }

    #[test]
    fn summary_reports_current_breakdown_and_previous_total() {
        let (_dir, db) = test_db();
        let now = Local::now();
        let previous = previous_month_key(now);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO ai_request_counts (month, feature, count) VALUES (?1, 'chat', 9)",
                params![previous],
            )
            .unwrap();
        }
        record(&db, "user", "explain");
        record(&db, "user", "xray");

        let result = summary(&db).unwrap();
        assert_eq!(result.previous_total, 9);
        assert_eq!(result.current.total, 2);
        assert_eq!(result.current.month, month_key(now));
    }
}
