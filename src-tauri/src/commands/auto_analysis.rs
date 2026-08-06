//! The one place a system-initiated AI call is authorised and accounted for.
//!
//! See docs/impls/auto-analysis-console-mockup.html. Two rules from that
//! design drive everything here:
//!
//! 1. **Nothing runs on its own without a switch in this registry.** A job
//!    that spends the reader's own API quota while they are not looking has
//!    to be refusable in one place, so `is_enabled` is a hard gate every
//!    automatic caller must pass through — not a convention.
//! 2. **Turning a job off never removes the feature**, only the automatic
//!    trigger. Every job here keeps a manual button on its own page, which
//!    is also what makes the in-place upgrade prompt possible: a reader who
//!    has pressed that button four times has demonstrated the value the
//!    switch is asking about.
//!
//! The registry deliberately lists only jobs whose analysis actually exists.
//! A switch that gates nothing is worse than a missing row — it reads as a
//! feature the reader has, and turning it off changes nothing.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// When a job runs. The console groups by this rather than by module,
/// because what the reader is deciding is when their quota gets spent, not
/// which part of the app spends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoAnalysisTrigger {
    /// Once, when a book is marked finished.
    BookFinished,
}

/// One system-initiated AI job.
#[derive(Debug, Clone, Copy)]
pub struct AutoAnalysisJob {
    /// Stable id, and — by requirement, not coincidence — the exact string
    /// the job's calls are tagged with in `ai_usage_records.feature`. The
    /// console totals a job's spend by that column, so a job whose id and
    /// feature tag drift apart silently reports zero forever.
    pub id: &'static str,
    pub trigger: AutoAnalysisTrigger,
}

/// Every job the reader can authorise.
///
/// One entry today: `reading_review` is the only automatic analysis whose
/// underlying generator exists (`commands::reading_stats`). The mockup's
/// other rows are absent on purpose until theirs do.
pub const JOBS: &[AutoAnalysisJob] = &[AutoAnalysisJob {
    id: "reading_review",
    trigger: AutoAnalysisTrigger::BookFinished,
}];

/// How many manual runs before the console offers to make a job automatic.
/// Four is the mockup's number: enough that the reader has clearly chosen
/// this feature on purpose, few enough that the offer still lands while the
/// last run is fresh.
const MANUAL_RUNS_BEFORE_RECOMMENDING: i64 = 4;

fn job(id: &str) -> AppResult<&'static AutoAnalysisJob> {
    JOBS.iter()
        .find(|job| job.id == id)
        .ok_or_else(|| AppError::Other("AUTO_ANALYSIS_JOB_UNKNOWN".to_string()))
}

fn enabled_key(id: &str) -> String {
    format!("auto_analysis_enabled_{id}")
}

fn manual_runs_key(id: &str) -> String {
    format!("auto_analysis_manual_runs_{id}")
}

fn dismissed_key(id: &str) -> String {
    format!("auto_analysis_recommend_dismissed_{id}")
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

/// Whether `job_id` may run automatically right now.
///
/// Absent means enabled: automatic analysis ships on, which the console can
/// only justify because it states plainly what each job does, whose quota it
/// spends, roughly how much, and offers the switch in the same view. A job
/// defaulting off would simply never run, and a feature that never runs was
/// not built.
///
/// Unknown ids are refused rather than defaulted — a caller asking about a
/// job that is not in the registry is a caller that was never reviewed here.
pub fn is_enabled(conn: &Connection, job_id: &str) -> bool {
    if !JOBS.iter().any(|job| job.id == job_id) {
        return false;
    }
    read_setting(conn, &enabled_key(job_id)).as_deref() != Some("false")
}

fn manual_runs(conn: &Connection, job_id: &str) -> i64 {
    read_setting(conn, &manual_runs_key(job_id))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0)
}

fn recommendation_dismissed(conn: &Connection, job_id: &str) -> bool {
    read_setting(conn, &dismissed_key(job_id)).as_deref() == Some("true")
}

/// One row of the console, plus everything the manual page needs to decide
/// whether to show its upgrade prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoAnalysisJobView {
    pub id: String,
    pub trigger: AutoAnalysisTrigger,
    pub enabled: bool,
    /// Recorded automatic calls and their tokens inside the console window.
    pub auto_calls: i64,
    pub auto_tokens: i64,
    /// How many times the reader has run this analysis by hand, ever.
    pub manual_runs: i64,
    /// Whether the manual page should offer to make this automatic — true
    /// only while the job is off, has been run by hand enough times to have
    /// proven itself, and the reader has not already said no.
    pub recommend_auto: bool,
}

/// Everything the settings console renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoAnalysisConsole {
    pub jobs: Vec<AutoAnalysisJobView>,
    /// Every `auto`-origin token in the window — including any spent by a
    /// job no longer in the registry, so the headline cannot shrink just
    /// because a row was removed.
    pub auto_tokens: i64,
    /// Every `user`-origin token in the window: the ratio's denominator.
    pub user_tokens: i64,
    /// `auto` as a whole percent of `user`, or `None` when the reader has
    /// spent nothing by hand yet. A ratio with no denominator is not "0%",
    /// it is "no answer yet" — and the console shows nothing rather than a
    /// number that would be wrong.
    pub ratio_percent: Option<i64>,
    /// Distinct providers that billed anything in the window, sorted.
    ///
    /// The console never converts tokens into money, so the only honest
    /// answer to "what did this cost" is a link to whoever is actually
    /// keeping the account. Which provider that is comes from what ran, not
    /// from what is configured — failover means the two differ.
    pub providers: Vec<String>,
}

fn providers_in_window(db: &Db, since_ms: i64) -> AppResult<Vec<String>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT provider FROM ai_usage_records
         WHERE created_at >= ?1 AND provider <> '' ORDER BY provider",
    )?;
    let rows = stmt.query_map(params![since_ms], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn console_inner(db: &Db, since_ms: i64) -> AppResult<AutoAnalysisConsole> {
    let auto = crate::ai::usage::by_feature(db, since_ms, "auto")?;
    let totals = crate::ai::usage::summary(db, since_ms)?;
    let providers = providers_in_window(db, since_ms)?;
    let conn = db.reader();
    let jobs = JOBS
        .iter()
        .map(|job| {
            let usage = auto.iter().find(|row| row.feature == job.id);
            let enabled = is_enabled(&conn, job.id);
            let runs = manual_runs(&conn, job.id);
            AutoAnalysisJobView {
                id: job.id.to_string(),
                trigger: job.trigger,
                enabled,
                auto_calls: usage.map_or(0, |row| row.calls),
                auto_tokens: usage
                    .map_or(0, |row| row.input_tokens.saturating_add(row.output_tokens)),
                manual_runs: runs,
                recommend_auto: !enabled
                    && runs >= MANUAL_RUNS_BEFORE_RECOMMENDING
                    && !recommendation_dismissed(&conn, job.id),
            }
        })
        .collect();
    let auto_tokens = totals.auto_input.saturating_add(totals.auto_output);
    let user_tokens = totals.user_input.saturating_add(totals.user_output);
    Ok(AutoAnalysisConsole {
        jobs,
        auto_tokens,
        user_tokens,
        ratio_percent: (user_tokens > 0).then(|| auto_tokens.saturating_mul(100) / user_tokens),
        providers,
    })
}

fn view_of(db: &Db, job_id: &str) -> AppResult<AutoAnalysisJobView> {
    let job = job(job_id)?;
    console_inner(db, 0)?
        .jobs
        .into_iter()
        .find(|view| view.id == job.id)
        .ok_or_else(|| AppError::Other("AUTO_ANALYSIS_JOB_UNKNOWN".to_string()))
}

/// The console's whole model, for automatic calls recorded at or after
/// `since_ms`.
#[tauri::command]
pub fn auto_analysis_console(since_ms: i64, db: State<'_, Db>) -> AppResult<AutoAnalysisConsole> {
    console_inner(&db, since_ms)
}

fn set_enabled_inner(db: &Db, job_id: &str, enabled: bool) -> AppResult<AutoAnalysisJobView> {
    let job = job(job_id)?;
    {
        let conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        write_setting(
            &conn,
            &enabled_key(job.id),
            if enabled { "true" } else { "false" },
        )?;
        if enabled {
            conn.execute(
                "DELETE FROM settings WHERE key = ?1",
                params![dismissed_key(job.id)],
            )?;
        }
    }
    view_of(db, job.id)
}

fn note_manual_run_inner(db: &Db, job_id: &str) -> AppResult<AutoAnalysisJobView> {
    let job = job(job_id)?;
    {
        let conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let next = manual_runs(&conn, job.id).saturating_add(1);
        write_setting(&conn, &manual_runs_key(job.id), &next.to_string())?;
    }
    view_of(db, job.id)
}

fn dismiss_recommendation_inner(db: &Db, job_id: &str) -> AppResult<AutoAnalysisJobView> {
    let job = job(job_id)?;
    {
        let conn = db
            .conn
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        write_setting(&conn, &dismissed_key(job.id), "true")?;
    }
    view_of(db, job.id)
}

/// Flip one job's switch.
///
/// Turning a job *on* also clears its dismissal: the reader answering the
/// upgrade prompt with "yes" should not leave behind a stored "no" that
/// suppresses the prompt forever if they later switch it off again.
#[tauri::command]
pub fn set_auto_analysis_enabled(
    job_id: String,
    enabled: bool,
    db: State<'_, Db>,
) -> AppResult<AutoAnalysisJobView> {
    set_enabled_inner(&db, &job_id, enabled)
}

/// Count one by-hand run of an analysis, and say whether its page should now
/// offer to make it automatic.
///
/// The count is the whole basis of the offer, so it is kept even while the
/// job is enabled — a reader who turns automatic analysis off later should
/// not have their history reset to zero and be re-asked from scratch.
#[tauri::command]
pub fn note_manual_analysis_run(
    job_id: String,
    db: State<'_, Db>,
) -> AppResult<AutoAnalysisJobView> {
    note_manual_run_inner(&db, &job_id)
}

/// Record that the reader declined the upgrade offer.
///
/// One refusal is permanent for that job. The prompt exists to catch someone
/// who has clearly found the feature useful; asking a second time after a no
/// is the nagging the whole product is built to avoid.
#[tauri::command]
pub fn dismiss_auto_analysis_recommendation(
    job_id: String,
    db: State<'_, Db>,
) -> AppResult<AutoAnalysisJobView> {
    dismiss_recommendation_inner(&db, &job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_usage(db: &Db, origin: &str, feature: &str, created_at: i64, tokens: i64) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ai_usage_records
                (id, created_at, provider, model, origin, feature, usage_json, input_tokens, output_tokens)
             VALUES (?1, ?2, 'anthropic', 'm', ?3, ?4, '{}', ?5, 0)",
            params![
                uuid::Uuid::new_v4().to_string(),
                created_at,
                origin,
                feature,
                tokens
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_job_nobody_has_touched_is_already_on() {
        let (_dir, db) = setup();
        let conn = db.reader();
        assert!(is_enabled(&conn, "reading_review"));
    }

    #[test]
    fn a_job_that_is_not_in_the_registry_can_never_run() {
        let (_dir, db) = setup();
        let conn = db.reader();
        // Not "unknown so assume on" — an unregistered caller has not been
        // reviewed, and the gate is the only thing standing between it and
        // the reader's quota.
        assert!(!is_enabled(&conn, "some_job_that_was_never_declared"));
    }

    #[test]
    fn switching_a_job_off_closes_the_gate() {
        let (_dir, db) = setup();
        let view = set_enabled_inner(&db, "reading_review", false).unwrap();
        assert!(!view.enabled);
        assert!(!is_enabled(&db.reader(), "reading_review"));
    }

    #[test]
    fn the_ratio_says_nothing_when_there_is_nothing_to_compare_against() {
        let (_dir, db) = setup();
        insert_usage(&db, "auto", "reading_review", 5_000, 900);
        let console = console_inner(&db, 0).unwrap();
        assert_eq!(console.auto_tokens, 900);
        assert_eq!(console.user_tokens, 0);
        // Not Some(0) and not a division by zero — "no answer yet".
        assert_eq!(console.ratio_percent, None);
    }

    #[test]
    fn the_billing_link_follows_whoever_actually_ran() {
        let (_dir, db) = setup();
        insert_usage(&db, "user", "lookup", 5_000, 10);
        insert_usage(&db, "auto", "reading_review", 5_000, 10);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE ai_usage_records SET provider = 'deepseek' WHERE origin = 'auto'",
                [],
            )
            .unwrap();
        }
        // Both providers billed something, so both are owed a link —
        // failover means what ran is not what is configured.
        let console = console_inner(&db, 0).unwrap();
        assert_eq!(console.providers, vec!["anthropic", "deepseek"]);
        // And a window that saw nothing offers no link at all.
        assert!(console_inner(&db, 900_000).unwrap().providers.is_empty());
    }

    #[test]
    fn the_ratio_is_automatic_spend_against_the_readers_own() {
        let (_dir, db) = setup();
        insert_usage(&db, "user", "lookup", 5_000, 1_000);
        insert_usage(&db, "auto", "reading_review", 5_000, 60);
        let console = console_inner(&db, 0).unwrap();
        assert_eq!(console.ratio_percent, Some(6));
    }

    #[test]
    fn spend_outside_the_window_is_not_counted() {
        let (_dir, db) = setup();
        insert_usage(&db, "auto", "reading_review", 1_000, 500);
        insert_usage(&db, "auto", "reading_review", 9_000, 70);
        let console = console_inner(&db, 5_000).unwrap();
        assert_eq!(console.auto_tokens, 70);
        assert_eq!(console.jobs[0].auto_calls, 1);
        assert_eq!(console.jobs[0].auto_tokens, 70);
    }

    #[test]
    fn a_job_no_longer_in_the_registry_still_counts_toward_the_headline() {
        let (_dir, db) = setup();
        insert_usage(&db, "user", "lookup", 5_000, 1_000);
        insert_usage(&db, "auto", "a_job_that_was_removed", 5_000, 200);
        let console = console_inner(&db, 0).unwrap();
        // The reader was charged for it, so the headline owes them the
        // number even though no row can explain it.
        assert_eq!(console.auto_tokens, 200);
        assert_eq!(console.ratio_percent, Some(20));
        assert_eq!(console.jobs[0].auto_tokens, 0);
    }

    #[test]
    fn the_offer_to_automate_waits_for_the_fourth_run_by_hand() {
        let (_dir, db) = setup();
        set_enabled_inner(&db, "reading_review", false).unwrap();
        for expected in 1..=3 {
            let view = bump(&db);
            assert_eq!(view.manual_runs, expected);
            assert!(!view.recommend_auto);
        }
        let view = bump(&db);
        assert_eq!(view.manual_runs, 4);
        assert!(view.recommend_auto);
    }

    #[test]
    fn an_enabled_job_never_asks_to_be_enabled() {
        let (_dir, db) = setup();
        for _ in 0..6 {
            let view = bump(&db);
            assert!(!view.recommend_auto);
        }
    }

    #[test]
    fn one_refusal_settles_it() {
        let (_dir, db) = setup();
        set_enabled_inner(&db, "reading_review", false).unwrap();
        for _ in 0..4 {
            bump(&db);
        }
        let dismissed = dismiss_recommendation_inner(&db, "reading_review").unwrap();
        assert!(!dismissed.recommend_auto);
        // Still counting, still refusing to ask again.
        let after = bump(&db);
        assert_eq!(after.manual_runs, 5);
        assert!(!after.recommend_auto);
    }

    #[test]
    fn saying_yes_lets_the_question_be_asked_again_after_a_later_refusal() {
        let (_dir, db) = setup();
        set_enabled_inner(&db, "reading_review", false).unwrap();
        for _ in 0..4 {
            bump(&db);
        }
        set_enabled_inner(&db, "reading_review", true).unwrap();
        let off = set_enabled_inner(&db, "reading_review", false).unwrap();
        assert!(off.recommend_auto);
    }

    #[test]
    fn an_unregistered_job_id_cannot_write_a_settings_row() {
        let (_dir, db) = setup();
        assert!(set_enabled_inner(&db, "../../etc/passwd", false).is_err());
        assert!(note_manual_run_inner(&db, "anything").is_err());
        assert!(dismiss_recommendation_inner(&db, "reading_review_").is_err());
        let conn = db.reader();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'auto_analysis_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    fn bump(db: &Db) -> AutoAnalysisJobView {
        note_manual_run_inner(db, "reading_review").unwrap()
    }
}
