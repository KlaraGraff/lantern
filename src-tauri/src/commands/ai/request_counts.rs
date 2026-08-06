//! Query command over the `ai_request_counts` table populated by
//! `crate::ai::request_counts::record`.
//!
//! Distinct from `ai_usage_summary` (token spend): this is the plain "how
//! many times did I ask AI something this month" the settings pane shows as
//! quiet reassurance, not a dashboard.

use tauri::State;

use crate::ai::request_counts::AiRequestCountsSummary;
use crate::db::Db;
use crate::error::AppResult;

/// This month's total + per-feature breakdown, plus last month's total for
/// context.
#[tauri::command]
pub fn ai_request_counts_summary(db: State<'_, Db>) -> AppResult<AiRequestCountsSummary> {
    crate::ai::request_counts::summary(&db)
}
