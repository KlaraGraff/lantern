//! Query command over the `ai_usage_records` table populated by
//! `crate::ai::usage::record`.
//!
//! Frontend UI is out of scope here — this command exists so the upcoming
//! auto-analysis console can compute "equivalent to X% of your manual
//! lookups" without shipping its own SQL.

use tauri::State;

use crate::ai::usage::AiUsageSummary;
use crate::db::Db;
use crate::error::AppResult;

/// Token totals grouped by call origin (`user` vs `auto`) since `since_ms`.
#[tauri::command]
pub fn ai_usage_summary(since_ms: i64, db: State<'_, Db>) -> AppResult<AiUsageSummary> {
    crate::ai::usage::summary(&db, since_ms)
}
